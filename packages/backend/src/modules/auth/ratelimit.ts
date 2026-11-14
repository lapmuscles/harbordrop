import type { AppContext, HdContext } from "../../core/context";
import { HttpError } from "../../core/errors";

export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60_000;
/** 失敗計數的觀察窗：超過此時間未再失敗則重新計算 */
export const WINDOW_MS = 15 * 60_000;

/** TRUST_PROXY 環境變數：true／1／yes 才信任代理標頭（預設 false） */
export function trustProxy(env: Record<string, unknown> | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(env?.TRUST_PROXY ?? "").trim());
}

/**
 * 用戶端 IP：
 *  - Workers：只用 Cloudflare 設定的 CF-Connecting-IP（用戶端無法偽造）。
 *  - Node 且 TRUST_PROXY=true（在反向代理後方）：CF-Connecting-IP → X-Real-IP → X-Forwarded-For 第一段 → 連線位址。
 *  - Node 且 TRUST_PROXY 未設定／false（預設，直接對外）：不信任任何代理標頭（含 X-Forwarded-For），只用 TCP 連線位址。
 */
export function clientIp(c: HdContext): string {
  const h = (n: string) => c.req.header(n)?.trim();
  const ctx = c.get("ctx") as AppContext | undefined;
  if (ctx?.platform === "workers") return h("cf-connecting-ip") || "unknown";
  const socketIp = ((c.env as any)?.incoming?.socket?.remoteAddress as string | undefined) || "";
  if (trustProxy(ctx?.env as Record<string, unknown> | undefined)) {
    return h("cf-connecting-ip") || h("x-real-ip") || h("x-forwarded-for")?.split(",")[0].trim() || socketIp || "unknown";
  }
  return socketIp || "unknown";
}

export function attemptKey(ip: string, username: string): string {
  return `${ip}|${username.trim().toLowerCase()}`;
}

interface AttemptRow {
  key: string;
  failures: number;
  first_failed_at: number;
  locked_until: number | null;
}

export function tooMany(lockedUntil: number, now = Date.now()) {
  const min = Math.max(1, Math.ceil((lockedUntil - now) / 60_000));
  return new HttpError(429, "too_many_attempts", `登入失敗次數過多，請 ${min} 分鐘後再試`, { lockedUntil });
}

/** 若已鎖定則丟出 429 */
export async function assertNotLocked(ctx: AppContext, key: string, now = Date.now()): Promise<void> {
  const row = await ctx.db.first<AttemptRow>("SELECT * FROM login_attempts WHERE key = ?", [key]);
  if (row?.locked_until && row.locked_until > now) throw tooMany(row.locked_until, now);
}

/** 記錄一次失敗；達上限時鎖定。回傳是否因此被鎖定 */
export async function recordFailure(ctx: AppContext, key: string, now = Date.now()): Promise<{ locked: boolean; lockedUntil?: number; remaining: number }> {
  const row = await ctx.db.first<AttemptRow>("SELECT * FROM login_attempts WHERE key = ?", [key]);
  const expired = !row || (row.locked_until != null && row.locked_until <= now) || now - row.first_failed_at > WINDOW_MS;
  const failures = expired ? 1 : row!.failures + 1;
  const first = expired ? now : row!.first_failed_at;
  const lockedUntil = failures >= MAX_FAILURES ? now + LOCK_MS : null;
  await ctx.db.run(
    "INSERT INTO login_attempts (key, failures, first_failed_at, locked_until, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, first_failed_at = excluded.first_failed_at, locked_until = excluded.locked_until, updated_at = excluded.updated_at",
    [key, failures, first, lockedUntil, now],
  );
  return { locked: lockedUntil != null, lockedUntil: lockedUntil ?? undefined, remaining: Math.max(0, MAX_FAILURES - failures) };
}

export async function clearFailures(ctx: AppContext, key: string): Promise<void> {
  await ctx.db.run("DELETE FROM login_attempts WHERE key = ?", [key]);
}

/** 清除過期紀錄（jobs: cleanup.expired 呼叫） */
export async function pruneAttempts(ctx: AppContext, now = Date.now()): Promise<number> {
  const r = await ctx.db.run("DELETE FROM login_attempts WHERE (locked_until IS NULL OR locked_until <= ?) AND updated_at < ?", [now, now - WINDOW_MS]);
  return r.changes;
}
