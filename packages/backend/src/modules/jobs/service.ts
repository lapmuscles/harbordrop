import type { AppContext } from "../../core/context";
import { badRequest, notFound } from "../../core/errors";

export type JobHandler = (ctx: AppContext, config: Record<string, unknown>) => Promise<string | void>;

export interface JobRow {
  id: number;
  kind: string;
  name: string;
  interval_seconds: number;
  config: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  last_status: string | null;
  last_message: string | null;
  created_at: number;
  updated_at: number;
}

export interface JobDto {
  id: number;
  kind: string;
  name: string;
  intervalSeconds: number;
  config: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: string | null;
  lastMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export const MIN_INTERVAL = 60;
export const MAX_INTERVAL = 366 * 86400;
/** cron 單次喚醒最多處理幾個工作、最多花多久（Workers 執行時間有限） */
const CRON_MAX_JOBS = 5;
const CRON_BUDGET_MS = 20_000;

function parseConfig(s: string | null | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(s ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function toDto(r: JobRow): JobDto {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    intervalSeconds: r.interval_seconds,
    config: parseConfig(r.config),
    enabled: !!r.enabled,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
    lastStatus: r.last_status,
    lastMessage: r.last_message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 所有模組提供的 kind → 處理函式 */
export function jobHandlers(ctx: AppContext): Map<string, JobHandler> {
  const m = new Map<string, JobHandler>();
  for (const mod of ctx.modules) for (const [k, fn] of Object.entries(mod.jobs ?? {})) if (!m.has(k)) m.set(k, fn);
  return m;
}

function validateInterval(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < MIN_INTERVAL || n > MAX_INTERVAL) throw badRequest(`執行間隔需為 ${MIN_INTERVAL} 秒到 366 天之間的整數秒數`);
  return n;
}
function validateConfig(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw badRequest("config 必須是物件");
  const s = JSON.stringify(v);
  if (s.length > 16_000) throw badRequest("config 過大");
  return v as Record<string, unknown>;
}
function validateName(v: unknown): string {
  const name = typeof v === "string" ? v.trim() : "";
  if (!name) throw badRequest("請輸入名稱");
  if (name.length > 100) throw badRequest("名稱過長（上限 100 字）");
  return name;
}

export async function getJob(ctx: AppContext, id: number): Promise<JobRow> {
  const r = await ctx.db.first<JobRow>("SELECT * FROM scheduled_jobs WHERE id = ?", [id]);
  if (!r) throw notFound("找不到排程工作");
  return r;
}

export async function listJobs(ctx: AppContext): Promise<JobDto[]> {
  return (await ctx.db.all<JobRow>("SELECT * FROM scheduled_jobs ORDER BY id")).map(toDto);
}

export async function createJob(ctx: AppContext, input: Record<string, unknown>): Promise<JobDto> {
  const kind = String(input.kind ?? "");
  if (!jobHandlers(ctx).has(kind)) throw badRequest(`未知的工作類型：${kind || "（空白）"}`, "unknown_job_kind");
  const name = validateName(input.name);
  const interval = validateInterval(input.intervalSeconds);
  const config = validateConfig(input.config);
  const now = Date.now();
  const next = input.nextRunAt != null ? Number(input.nextRunAt) : now; // 預設下一次喚醒就執行
  if (!Number.isFinite(next)) throw badRequest("下次執行時間格式錯誤");
  const r = await ctx.db.run(
    "INSERT INTO scheduled_jobs (kind, name, interval_seconds, config, enabled, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [kind, name, interval, JSON.stringify(config), input.enabled === false ? 0 : 1, next, now, now],
  );
  return toDto(await getJob(ctx, r.lastRowId));
}

export async function updateJob(ctx: AppContext, id: number, input: Record<string, unknown>): Promise<JobDto> {
  const cur = await getJob(ctx, id);
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    params.push(v);
  };
  if (input.name !== undefined) set("name", validateName(input.name));
  if (input.intervalSeconds !== undefined) {
    const iv = validateInterval(input.intervalSeconds);
    set("interval_seconds", iv);
    // 縮短間隔時讓下次執行時間跟著提前
    if (input.nextRunAt === undefined && cur.last_run_at) set("next_run_at", Math.min(cur.next_run_at ?? Infinity, cur.last_run_at + iv * 1000));
  }
  if (input.config !== undefined) set("config", JSON.stringify(validateConfig(input.config)));
  if (input.enabled !== undefined) {
    set("enabled", input.enabled ? 1 : 0);
    if (input.enabled && !cur.enabled && input.nextRunAt === undefined && (cur.next_run_at ?? 0) < Date.now()) set("next_run_at", Date.now());
  }
  if (input.nextRunAt !== undefined) {
    const n = input.nextRunAt === null ? Date.now() : Number(input.nextRunAt);
    if (!Number.isFinite(n)) throw badRequest("下次執行時間格式錯誤");
    set("next_run_at", n);
  }
  if (sets.length) {
    set("updated_at", Date.now());
    await ctx.db.run(`UPDATE scheduled_jobs SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  }
  return toDto(await getJob(ctx, id));
}

export async function deleteJob(ctx: AppContext, id: number): Promise<void> {
  await getJob(ctx, id);
  await ctx.db.run("DELETE FROM scheduled_jobs WHERE id = ?", [id]);
}

/** 執行一個工作並寫回 last_*、next_run_at（不論成功失敗都排下一次） */
export async function runJob(ctx: AppContext, job: JobRow, now = Date.now()): Promise<JobDto> {
  const handler = jobHandlers(ctx).get(job.kind);
  let status = "ok";
  let message = "";
  if (!handler) {
    status = "error";
    message = `未知的工作類型：${job.kind}`;
  } else {
    try {
      message = (await handler(ctx, parseConfig(job.config))) ?? "";
    } catch (e) {
      status = "error";
      message = e instanceof Error ? e.message : String(e);
    }
  }
  const finished = Date.now();
  await ctx.db.run("UPDATE scheduled_jobs SET last_run_at = ?, last_status = ?, last_message = ?, next_run_at = ?, updated_at = ? WHERE id = ?", [
    finished,
    status,
    message.slice(0, 1000),
    now + job.interval_seconds * 1000,
    finished,
    job.id,
  ]);
  return toDto(await getJob(ctx, job.id));
}

/**
 * 排程喚醒：找出到期的工作，先「認領」（以樂觀鎖把 next_run_at 往後推，避免多個執行個體重複執行），再執行。
 */
export async function cronTick(ctx: AppContext, now = Date.now()): Promise<number[]> {
  const started = Date.now();
  const due = await ctx.db.all<JobRow>(
    "SELECT * FROM scheduled_jobs WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY COALESCE(next_run_at, 0) LIMIT ?",
    [now, CRON_MAX_JOBS],
  );
  const ran: number[] = [];
  for (const job of due) {
    if (Date.now() - started > CRON_BUDGET_MS) break;
    const claim = await ctx.db.run(
      "UPDATE scheduled_jobs SET next_run_at = ?, last_status = 'running' WHERE id = ? AND enabled = 1 AND COALESCE(next_run_at, 0) = ?",
      [now + job.interval_seconds * 1000, job.id, job.next_run_at ?? 0],
    );
    if (claim.changes !== 1) continue;
    await runJob(ctx, job, now);
    ran.push(job.id);
  }
  return ran;
}

/** 內建：cleanup.expired。config.deleteFiles = true 時一併刪除過期分享的儲存檔案 */
export async function cleanupExpired(ctx: AppContext, config: Record<string, unknown>): Promise<string> {
  const now = Date.now();
  const expiredWhere = "(expires_at IS NOT NULL AND expires_at <= ?) OR (max_views IS NOT NULL AND views >= max_views)";
  let filesDeleted = 0;
  let fileErrors = 0;
  if (config.deleteFiles === true) {
    const rows = await ctx.db.all<{ storage_id: number | null; object_path: string }>(`SELECT storage_id, object_path FROM shares WHERE ${expiredWhere}`, [now]);
    const byStorage = new Map<number, string[]>();
    for (const r of rows) if (r.storage_id != null) byStorage.set(r.storage_id, [...(byStorage.get(r.storage_id) ?? []), r.object_path]);
    for (const [sid, paths] of byStorage) {
      try {
        const d = await ctx.storage.driver(sid);
        if (!d.delete) {
          fileErrors += paths.length;
          continue;
        }
        await d.delete(paths);
        filesDeleted += paths.length;
      } catch {
        fileErrors += paths.length;
      }
    }
  }
  const shares = (await ctx.db.run(`DELETE FROM shares WHERE ${expiredWhere}`, [now])).changes;
  const pastes = (await ctx.db.run(`DELETE FROM pastes WHERE ${expiredWhere}`, [now])).changes;
  const uploads = (await ctx.db.run("DELETE FROM upload_sessions WHERE expires_at < ?", [now])).changes;
  const sessions = (await ctx.db.run("DELETE FROM sessions WHERE expires_at < ?", [now])).changes;
  await ctx.db.run("DELETE FROM login_challenges WHERE expires_at < ?", [now]);
  await ctx.db.run("DELETE FROM login_attempts WHERE (locked_until IS NULL OR locked_until <= ?) AND updated_at < ?", [now, now - 15 * 60_000]);
  const parts = [`分享 ${shares}`, `文字分享 ${pastes}`, `上傳工作階段 ${uploads}`, `登入工作階段 ${sessions}`];
  if (config.deleteFiles === true) parts.push(`檔案 ${filesDeleted}${fileErrors ? `（${fileErrors} 個刪除失敗）` : ""}`);
  return `已清除：${parts.join("、")}`;
}

export const JOB_KIND_LABELS: Record<string, string> = {
  "cleanup.expired": "清除過期分享與工作階段",
  "search.reindex": "重建搜尋索引",
  "backup.export": "匯出備份",
  "mirror.sync": "鏡像同步",
};
