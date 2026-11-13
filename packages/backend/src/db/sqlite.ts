import type BetterSqlite3 from "better-sqlite3";
import { type Db, normParams } from "./adapter";

export function createSqliteDb(db: BetterSqlite3.Database): Db {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const run = (sql: string, params?: unknown[]) => {
    const r = db.prepare(sql).run(...normParams(params));
    return { changes: r.changes, lastRowId: Number(r.lastInsertRowid) };
  };
  return {
    async all(sql, params) {
      return db.prepare(sql).all(...normParams(params)) as any[];
    },
    async first(sql, params) {
      return (db.prepare(sql).get(...normParams(params)) ?? null) as any;
    },
    async run(sql, params) {
      return run(sql, params);
    },
    async batch(statements) {
      return db.transaction(() => statements.map((s) => run(s.sql, s.params)))();
    },
    async exec(sql) {
      db.exec(sql);
    },
  };
}
