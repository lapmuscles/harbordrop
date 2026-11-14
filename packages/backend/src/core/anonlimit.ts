import type { AppContext, HdContext } from "./context";
import { HttpError } from "./errors";

export const HOUR_MS = 3600_000;
export type AnonKind = "upload" | "paste";

/** 各動作對應的設定鍵（每 IP 每小時次數，0 = 不限） */
export const ANON_LIMIT_SETTING: Record<AnonKind, string> = {
  upload: "anonUploadPerHour",
  paste: "anonPastePerHour",
};

/** TRUST_PROXY：1／true／yes／on 才信任代理標頭（預設不信任；與 ops 分支 auth/ratelimit 的語意一致） */
export function trustProxy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(v ?? "").trim());
}

/**
 * 匿名用戶端 IP：
 *  - Workers：只用 Cloudflare 設定的 CF-Connecting-IP（用戶端無法偽造）。
 *  - Node 且 TRUST_PROXY=true（在反向代理後方）：CF-Connecting-IP → X-Real-IP → X-Forwarded-For 第一段 → 連線位址。
 *  - Node 且 TRUST_PROXY 未設定／false（直接對外）：不信任任何代理標頭，只用 TCP 連線位址。
 */
export function anonClientIp(c: HdContext): string {
  const h = (n: string) => c.req.header(n)?.trim();
  const ctx = c.get("ctx");
  if (ctx.platform === "workers") return h("cf-connecting-ip") || "unknown";
  const socketIp = ((c.env as any)?.incoming?.socket?.remoteAddress as string | undefined) || "";
  if (trustProxy(ctx.env.TRUST_PROXY)) {
    return h("cf-connecting-ip") || h("x-real-ip") || h("x-forwarded-for")?.split(",")[0].trim() || socketIp || "unknown";
  }
  return socketIp || "unknown";
}

/**
 * 記錄一次匿名動作；超過每小時上限時丟出 429（不計入該次）。
 * 固定視窗：以整點為界，視窗過了就重新計數。
 */
export async function hitAnonLimit(ctx: AppContext, kind: AnonKind, ip: string, now = Date.now()): Promise<{ count: number; limit: number }> {
  const limit = Math.max(0, Math.floor(Number(await ctx.settings.get(ANON_LIMIT_SETTING[kind])) || 0));
  if (!limit) return { count: 0, limit: 0 };
  const key = `${kind}|${ip}`;
  const windowStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const row = await ctx.db.first<{ window_start: number; count: number }>("SELECT window_start, count FROM anon_rate WHERE key = ?", [key]);
  const current = row && row.window_start === windowStart ? row.count : 0;
  if (current >= limit) {
    const retry = Math.max(1, Math.ceil((windowStart + HOUR_MS - now) / 60_000));
    throw new HttpError(429, "anon_rate_limited", `匿名${kind === "upload" ? "上傳" : "文字分享"}次數已達每小時上限（${limit} 次），請 ${retry} 分鐘後再試`, {
      retryAfterMinutes: retry,
      limit,
    });
  }
  await ctx.db.run(
    "INSERT INTO anon_rate (key, window_start, count, updated_at) VALUES (?, ?, 1, ?) " +
      "ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = CASE WHEN anon_rate.window_start = excluded.window_start THEN anon_rate.count + 1 ELSE 1 END, updated_at = excluded.updated_at",
    [key, windowStart, now],
  );
  return { count: current + 1, limit };
}

/** 刪除已過期視窗的紀錄 */
export async function pruneAnonRate(ctx: AppContext, now = Date.now()): Promise<number> {
  const r = await ctx.db.run("DELETE FROM anon_rate WHERE window_start < ?", [Math.floor(now / HOUR_MS) * HOUR_MS]);
  return r.changes;
}
