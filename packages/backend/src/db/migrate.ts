import { type Db, splitSql } from "./adapter";
import { MIGRATIONS } from "./migrations/index.gen";

/** SQLite 的 ALTER TABLE … ADD COLUMN 沒有 IF NOT EXISTS，欄位已存在時會報 duplicate column name */
const ADD_COLUMN = /^ALTER\s+TABLE\s+[`"[]?(\w+)[`"\]]?\s+ADD\s+(?:COLUMN\s+)?[`"[]?(\w+)/i;

function isDuplicateColumn(e: unknown): boolean {
  return /duplicate column name/i.test(String((e as any)?.message ?? e));
}

/** 逐句執行；欄位已存在的 ADD COLUMN 直接略過，讓每支遷移都可安全重跑 */
async function applyIdempotent(db: Db, sql: string): Promise<void> {
  for (const raw of splitSql(sql)) {
    const stmt = raw.replace(/^(?:\s*--[^\n]*\n)+/, "").trim();
    if (!stmt) continue;
    try {
      await db.exec(stmt);
    } catch (e) {
      if (ADD_COLUMN.test(stmt) && isDuplicateColumn(e)) continue;
      throw e;
    }
  }
}

/**
 * 已用 `wrangler d1 migrations apply` 套用過的遷移記錄在 d1_migrations；
 * 這裡讀進來視為已完成，避免執行期自動遷移重跑同一支。
 */
async function wranglerApplied(db: Db): Promise<Set<string>> {
  try {
    const t = await db.first("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'");
    if (!t) return new Set();
    return new Set((await db.all<{ name: string }>("SELECT name FROM d1_migrations")).map((r) => r.name));
  } catch {
    return new Set();
  }
}

/**
 * 執行期自動遷移（Workers 第一個請求、Node 啟動時）。
 * - 記錄表 `_hd_migrations`；同時承認 wrangler 的 `d1_migrations` 記錄。
 * - 每支遷移可重跑：CREATE 皆為 IF NOT EXISTS，ADD COLUMN 遇到已存在的欄位會略過。
 */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec("CREATE TABLE IF NOT EXISTS _hd_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set((await db.all<{ name: string }>("SELECT name FROM _hd_migrations")).map((r) => r.name));
  const byWrangler = await wranglerApplied(db);
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    if (!byWrangler.has(m.name)) {
      await applyIdempotent(db, m.sql);
      applied.push(m.name);
    }
    await db.run("INSERT OR IGNORE INTO _hd_migrations (name, applied_at) VALUES (?, ?)", [m.name, Date.now()]);
  }
  return applied;
}
