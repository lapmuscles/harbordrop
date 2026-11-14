import type { AppContext } from "../../core/context";
import { randomId } from "../../core/crypto";
import { notFound } from "../../core/errors";

/**
 * 背景工作服務。其他模組可 import 本檔：
 *   createTask(ctx, kind, payload, opts) → 建立 pending 工作
 *   registerTaskHandler(kind, handler)   → 註冊分段執行函式
 *   updateProgress() / finish()          → 回報進度、結束
 * 執行：tasks 模組的 cron() 呼叫 runTasks()，每次在時間預算內推進一段（Workers 單次執行有限），
 * 處理函式需把續跑狀態寫回 payload（updateProgress 的 payload 參數）。
 */

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface TaskRow {
  id: string;
  kind: string;
  status: TaskStatus;
  progress: number;
  total: number;
  payload: string;
  result: string | null;
  error: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface TaskView {
  id: string;
  kind: string;
  status: TaskStatus;
  progress: number;
  total: number;
  payload: any;
  result: any;
  error: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export function taskView(r: TaskRow): TaskView {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    progress: r.progress,
    total: r.total,
    payload: JSON.parse(r.payload || "{}"),
    result: r.result ? JSON.parse(r.result) : null,
    error: r.error,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/** 處理函式：執行一段後返回。done=true 表示完成（result 存入 tasks.result）。 */
export interface TaskStepContext {
  /** 本段截止時間（Date.now() 毫秒）；超過時應盡快返回 */
  deadline: number;
  /** 工作是否已被取消（每處理一項可檢查一次） */
  isCancelled(): Promise<boolean>;
}
export type TaskHandler = (ctx: AppContext, task: TaskView, step: TaskStepContext) => Promise<{ done: boolean; result?: unknown }>;

const HANDLERS = new Map<string, TaskHandler>();
export function registerTaskHandler(kind: string, handler: TaskHandler) {
  HANDLERS.set(kind, handler);
}
export function getTaskHandler(kind: string) {
  return HANDLERS.get(kind);
}

export async function createTask(ctx: AppContext, kind: string, payload: unknown, opts: { createdBy?: string; total?: number } = {}): Promise<string> {
  const id = randomId(16);
  const now = Date.now();
  await ctx.db.run(
    "INSERT INTO tasks (id, kind, status, progress, total, payload, created_by, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?, ?, ?, ?)",
    [id, kind, opts.total ?? 0, JSON.stringify(payload ?? {}), opts.createdBy ?? "system", now, now],
  );
  return id;
}

export async function getTask(ctx: AppContext, id: string): Promise<TaskRow> {
  const r = await ctx.db.first<TaskRow>("SELECT * FROM tasks WHERE id = ?", [id]);
  if (!r) throw notFound("找不到此工作");
  return r;
}

export async function updateProgress(ctx: AppContext, id: string, p: { progress?: number; total?: number; payload?: unknown }): Promise<void> {
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [Date.now()];
  if (p.progress !== undefined) sets.push("progress = ?"), params.push(p.progress);
  if (p.total !== undefined) sets.push("total = ?"), params.push(p.total);
  if (p.payload !== undefined) sets.push("payload = ?"), params.push(JSON.stringify(p.payload));
  params.push(id);
  // 已結束（含取消）的工作不再更新
  await ctx.db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND status IN ('pending', 'running')`, params);
}

export async function finish(ctx: AppContext, id: string, outcome: { status?: "succeeded" | "failed"; result?: unknown; error?: string } = {}): Promise<void> {
  const now = Date.now();
  const status = outcome.status ?? (outcome.error ? "failed" : "succeeded");
  await ctx.db.run(
    "UPDATE tasks SET status = ?, result = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'running')",
    [status, outcome.result === undefined ? null : JSON.stringify(outcome.result), outcome.error ?? null, now, now, id],
  );
}

export async function cancelTask(ctx: AppContext, id: string): Promise<boolean> {
  const now = Date.now();
  const r = await ctx.db.run(
    "UPDATE tasks SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'running')",
    [now, now, id],
  );
  return r.changes > 0;
}

/**
 * 推進未完成的工作（依建立時間），在 budgetMs 內盡量多做。回傳本次處理過的工作 id。
 * 沒有處理函式的 kind 會標記失敗，避免卡住佇列。
 */
export async function runTasks(ctx: AppContext, opts: { budgetMs?: number; limit?: number } = {}): Promise<string[]> {
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  const rows = await ctx.db.all<TaskRow>(
    "SELECT * FROM tasks WHERE status IN ('pending', 'running') ORDER BY created_at LIMIT ?",
    [opts.limit ?? 10],
  );
  const touched: string[] = [];
  for (const r of rows) {
    if (Date.now() >= deadline) break;
    touched.push(r.id);
    const handler = HANDLERS.get(r.kind);
    if (!handler) {
      await finish(ctx, r.id, { error: `沒有可執行「${r.kind}」的處理程式` });
      continue;
    }
    if (r.status === "pending") {
      const now = Date.now();
      await ctx.db.run("UPDATE tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'", [now, now, r.id]);
      r.status = "running";
    }
    const step: TaskStepContext = {
      deadline,
      async isCancelled() {
        const cur = await ctx.db.first<{ status: string }>("SELECT status FROM tasks WHERE id = ?", [r.id]);
        return !cur || cur.status === "cancelled";
      },
    };
    try {
      const fresh = await getTask(ctx, r.id);
      if (fresh.status !== "running") continue;
      const out = await handler(ctx, taskView(fresh), step);
      if (out.done) await finish(ctx, r.id, { status: "succeeded", result: out.result });
    } catch (e: any) {
      await finish(ctx, r.id, { error: String(e?.message ?? e).slice(0, 1000) });
    }
  }
  return touched;
}
