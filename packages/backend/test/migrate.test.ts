import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createSqliteDb } from "../src/db/sqlite";
import { migrate } from "../src/db/migrate";
import { MIGRATIONS } from "../src/db/migrations/index.gen";

/** 模擬 `wrangler d1 migrations apply`：直接執行 .sql 並記錄在 d1_migrations */
function wranglerApply(sqlite: Database.Database, upTo = MIGRATIONS.length) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)");
  for (const m of MIGRATIONS.slice(0, upTo)) {
    sqlite.exec(m.sql);
    sqlite.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, datetime('now'))").run(m.name);
  }
}

const cols = (s: Database.Database, t: string) => (s.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);

describe("遷移可與 wrangler 共存、可重跑", () => {
  it("先用 wrangler 全部套用，執行期遷移不再重跑也不報錯", async () => {
    const sqlite = new Database(":memory:");
    wranglerApply(sqlite);
    const db = createSqliteDb(sqlite);
    expect(await migrate(db)).toEqual([]);
    expect(await migrate(db)).toEqual([]);
    const rec = (sqlite.prepare("SELECT name FROM _hd_migrations ORDER BY name").all() as any[]).map((r) => r.name);
    expect(rec).toEqual(MIGRATIONS.map((m) => m.name));
  });

  it("wrangler 只套用一部分，其餘由執行期補上", async () => {
    const sqlite = new Database(":memory:");
    wranglerApply(sqlite, 3);
    const db = createSqliteDb(sqlite);
    expect(await migrate(db)).toEqual(MIGRATIONS.slice(3).map((m) => m.name));
    expect(cols(sqlite, "pastes")).toContain("remark");
  });

  it("欄位已存在但沒有任何紀錄（例如 wrangler 套用後紀錄遺失）時，ADD COLUMN 略過", async () => {
    const sqlite = new Database(":memory:");
    for (const m of MIGRATIONS) sqlite.exec(m.sql); // 已執行過全部 SQL，但兩邊都沒有紀錄
    const db = createSqliteDb(sqlite);
    expect(await migrate(db)).toEqual(MIGRATIONS.map((m) => m.name));
    expect(cols(sqlite, "admins")).toContain("totp_enabled");
    expect(cols(sqlite, "pastes").filter((c) => c === "size")).toHaveLength(1);
  });

  it("其他錯誤仍會拋出，不會被吞掉", async () => {
    const sqlite = new Database(":memory:");
    const db = createSqliteDb(sqlite);
    await migrate(db);
    sqlite.exec("DELETE FROM _hd_migrations WHERE name = '0004_pastes.sql'");
    sqlite.exec("DROP TABLE pastes");
    await expect(migrate(db)).rejects.toThrow();
  });
});
