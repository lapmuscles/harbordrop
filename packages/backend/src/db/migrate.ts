import type { Db } from "./adapter";
import { MIGRATIONS } from "./migrations/index.gen";

/** 執行期自動遷移（D1 也可改用 `wrangler d1 migrations apply`，兩者記錄互不衝突，SQL 皆為 IF NOT EXISTS） */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec("CREATE TABLE IF NOT EXISTS _hd_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const done = new Set((await db.all<{ name: string }>("SELECT name FROM _hd_migrations")).map((r) => r.name));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    await db.exec(m.sql);
    await db.run("INSERT INTO _hd_migrations (name, applied_at) VALUES (?, ?)", [m.name, Date.now()]);
    applied.push(m.name);
  }
  return applied;
}
