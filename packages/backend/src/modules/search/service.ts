import type { AppContext } from "../../core/context";
import { joinPath, normalizePath } from "../../storage/util";
import { loadMounts, type MountRow } from "../fs/mounts";
import { createTask, type TaskStepContext, type TaskView, updateProgress } from "../tasks/service";

export const REINDEX_KIND = "search.reindex";
export type Tokenizer = "trigram" | "unicode61" | "none";

/**
 * 建立（或偵測）FTS5 表 search_fts（rowid = search_index.id）。
 * 優先 trigram（中文子字串可搜），不支援時用 unicode61，FTS5 完全不可用則回傳 none（只用 LIKE）。
 */
const tokCache = new WeakMap<object, Tokenizer>();
export async function ensureFts(ctx: AppContext): Promise<Tokenizer> {
  const cached = tokCache.get(ctx.db);
  if (cached) return cached;
  let tok: Tokenizer = "none";
  const row = await ctx.db.first<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'search_fts'");
  if (row) tok = /trigram/i.test(row.sql) ? "trigram" : "unicode61";
  else {
    for (const t of ["trigram", "unicode61"] as const) {
      try {
        await ctx.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(name, path UNINDEXED, tokenize='${t}')`);
        tok = t;
        break;
      } catch {
        /* 換下一個 tokenizer */
      }
    }
    // 既有索引資料補進 FTS（search_index 用 AUTOINCREMENT，id 不會重複使用）
    if (tok !== "none") await ctx.db.run("INSERT INTO search_fts (rowid, name, path) SELECT id, name, path FROM search_index");
  }
  tokCache.set(ctx.db, tok);
  return tok;
}

const under = (p: string, base: string) => base === "/" || p === base || p.startsWith(base + "/");

/** 掛載內剩餘路徑 → 虛擬路徑 */
export function vpathOf(m: MountRow, rest: string): string {
  return m.mount_path === "/" ? normalizePath(rest) : rest === "/" ? m.mount_path : m.mount_path + normalizePath(rest);
}

export async function clearMount(ctx: AppContext, mountId: number, tok: Tokenizer) {
  const stmts: { sql: string; params?: unknown[] }[] = [];
  if (tok !== "none") stmts.push({ sql: "DELETE FROM search_fts WHERE rowid IN (SELECT id FROM search_index WHERE mount_id = ?)", params: [mountId] });
  stmts.push({ sql: "DELETE FROM search_index WHERE mount_id = ?", params: [mountId] });
  await ctx.db.batch(stmts);
}

async function clearOrphans(ctx: AppContext, tok: Tokenizer) {
  const stmts: { sql: string; params?: unknown[] }[] = [];
  if (tok !== "none") stmts.push({ sql: "DELETE FROM search_fts WHERE rowid IN (SELECT id FROM search_index WHERE mount_id NOT IN (SELECT id FROM mounts))" });
  stmts.push({ sql: "DELETE FROM search_index WHERE mount_id NOT IN (SELECT id FROM mounts)" });
  await ctx.db.batch(stmts);
}

// ───────── 重建索引（tasks 分段執行） ─────────
export interface ReindexPayload {
  /** 尚未處理的掛載 ID */
  mounts: number[];
  /** 進行中的掛載 */
  current: { mountId: number; queue: string[]; cursor?: string } | null;
  indexed: number;
  skipped: { mountId: number; reason: string }[];
}

export async function startReindex(ctx: AppContext, opts: { mountId?: number; createdBy?: string } = {}): Promise<string> {
  const mounts = (await loadMounts(ctx)).filter((m) => opts.mountId === undefined || m.id === opts.mountId);
  const payload: ReindexPayload = { mounts: mounts.map((m) => m.id), current: null, indexed: 0, skipped: [] };
  if (opts.mountId === undefined) await clearOrphans(ctx, await ensureFts(ctx));
  return createTask(ctx, REINDEX_KIND, payload, { createdBy: opts.createdBy ?? "system", total: 0 });
}

const BATCH = 200;

export async function runReindexStep(ctx: AppContext, task: TaskView, step: TaskStepContext): Promise<{ done: boolean; result?: unknown }> {
  const tok = await ensureFts(ctx);
  const pl = task.payload as unknown as ReindexPayload;
  pl.skipped ??= [];
  const all = await loadMounts(ctx, true);
  const byId = new Map(all.map((m) => [m.id, m]));
  const enabled = all.filter((m) => m.enabled);
  let pages = 0;
  while (Date.now() < step.deadline) {
    if (!pl.current) {
      const next = pl.mounts.shift();
      if (next === undefined) return { done: true, result: { indexed: pl.indexed, skipped: pl.skipped } };
      await clearMount(ctx, next, tok);
      pl.current = { mountId: next, queue: ["/"] };
    }
    const cur = pl.current;
    const m = byId.get(cur.mountId);
    if (!m || !m.enabled) {
      pl.skipped.push({ mountId: cur.mountId, reason: "掛載不存在或已停用" });
      pl.current = null;
      continue;
    }
    let driver;
    try {
      const row = await ctx.storage.row(m.storage_id);
      if (!row.enabled) throw new Error("儲存已停用");
      driver = await ctx.storage.driverFor(row);
    } catch (e: any) {
      pl.skipped.push({ mountId: m.id, reason: String(e?.message ?? e) });
      pl.current = null;
      continue;
    }
    if (!driver.list) {
      pl.skipped.push({ mountId: m.id, reason: "此儲存不支援列目錄" });
      pl.current = null;
      continue;
    }
    const dir = cur.queue[0];
    if (dir === undefined) {
      pl.current = null;
      continue;
    }
    let res;
    try {
      res = await driver.list(joinPath(m.root_path, dir), { cursor: cur.cursor, limit: 1000 });
    } catch (e: any) {
      pl.skipped.push({ mountId: m.id, reason: `${dir}：${String(e?.message ?? e).slice(0, 200)}` });
      cur.queue.shift();
      cur.cursor = undefined;
      continue;
    }
    const now = Date.now();
    const rows: { rest: string; vpath: string; name: string; isDir: boolean; size?: number; modifiedAt?: number }[] = [];
    for (const e of res.entries) {
      const rest = (dir === "/" ? "" : dir) + "/" + e.name;
      const vpath = vpathOf(m, rest);
      // 被更深的掛載點遮蔽的路徑不索引（由該掛載自己索引）
      if (enabled.some((o) => o.id !== m.id && o.mount_path.length > m.mount_path.length && under(vpath, o.mount_path))) continue;
      rows.push({ rest, vpath, name: e.name, isDir: e.isDir, size: e.size, modifiedAt: e.modifiedAt });
      if (e.isDir) cur.queue.push(rest);
    }
    for (let i = 0; i < rows.length; i += BATCH) {
      const stmts: { sql: string; params?: unknown[] }[] = [];
      for (const r of rows.slice(i, i + BATCH)) {
        stmts.push({
          sql: "INSERT OR IGNORE INTO search_index (mount_id, path, name, name_lower, is_dir, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          params: [m.id, r.vpath, r.name, r.name.toLowerCase(), r.isDir ? 1 : 0, r.size ?? null, r.modifiedAt ?? null, now],
        });
        if (tok !== "none")
          stmts.push({
            sql: "INSERT INTO search_fts (rowid, name, path) SELECT id, name, path FROM search_index WHERE mount_id = ? AND path = ? AND NOT EXISTS (SELECT 1 FROM search_fts WHERE rowid = search_index.id)",
            params: [m.id, r.vpath],
          });
      }
      await ctx.db.batch(stmts);
    }
    pl.indexed += rows.length;
    if (res.cursor) cur.cursor = res.cursor;
    else {
      cur.queue.shift();
      cur.cursor = undefined;
    }
    await updateProgress(ctx, task.id, { progress: pl.indexed, payload: pl });
    if (++pages % 5 === 0 && (await step.isCancelled())) return { done: false };
  }
  await updateProgress(ctx, task.id, { progress: pl.indexed, payload: pl });
  return { done: false };
}

// ───────── 查詢 ─────────
export interface SearchRow {
  id: number;
  mount_id: number;
  vpath: string;
  name: string;
  is_dir: number;
  size: number | null;
  modified_at: number | null;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);
const ftsPhrase = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * 依名稱搜尋。trigram：每個詞 ≥3 字元時用 MATCH，否則 LIKE；unicode61：ASCII 詞用前綴 MATCH，含非 ASCII 用 LIKE。
 * prefix：只搜此虛擬路徑之下。
 */
export async function queryIndex(ctx: AppContext, q: string, opts: { prefix?: string; limit: number }): Promise<SearchRow[]> {
  const tok = await ensureFts(ctx);
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return [];
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.prefix && opts.prefix !== "/") {
    where.push("(s.path = ? OR s.path LIKE ? ESCAPE '\\')");
    params.push(opts.prefix, likeEscape(opts.prefix) + "/%");
  }
  const ftsTerms: string[] = [];
  for (const t of terms) {
    const useFts =
      (tok === "trigram" && [...t].length >= 3) || (tok === "unicode61" && /^[\x20-\x7e]+$/.test(t) && /[A-Za-z0-9]/.test(t));
    if (useFts) ftsTerms.push(tok === "unicode61" ? ftsPhrase(t) + "*" : ftsPhrase(t));
    else {
      where.push("s.name LIKE ? ESCAPE '\\'");
      params.push(`%${likeEscape(t)}%`);
    }
  }
  const cols = "s.id, s.mount_id, s.path AS vpath, s.name, s.is_dir, s.size, s.modified_at";
  if (ftsTerms.length) {
    const sql = `SELECT ${cols} FROM search_fts f JOIN search_index s ON s.id = f.rowid WHERE search_fts MATCH ? ${
      where.length ? "AND " + where.join(" AND ") : ""
    } ORDER BY f.rank LIMIT ?`;
    return ctx.db.all<SearchRow>(sql, [`name : (${ftsTerms.join(" AND ")})`, ...params, opts.limit]);
  }
  const sql = `SELECT ${cols} FROM search_index s WHERE ${where.join(" AND ")} ORDER BY s.is_dir DESC, length(s.name), s.name LIMIT ?`;
  return ctx.db.all<SearchRow>(sql, [...params, opts.limit]);
}
