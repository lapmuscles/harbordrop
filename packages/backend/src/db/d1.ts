import type { D1Database } from "@cloudflare/workers-types";
import { type Db, normParams, splitSql } from "./adapter";

export function createD1Db(d1: D1Database): Db {
  const prep = (sql: string, params?: unknown[]) => d1.prepare(sql).bind(...normParams(params));
  return {
    async all(sql, params) {
      const r = await prep(sql, params).all();
      return (r.results ?? []) as any[];
    },
    async first(sql, params) {
      return ((await prep(sql, params).first()) ?? null) as any;
    },
    async run(sql, params) {
      const r = await prep(sql, params).run();
      return { changes: r.meta?.changes ?? 0, lastRowId: r.meta?.last_row_id ?? 0 };
    },
    async batch(statements) {
      const rs = await d1.batch(statements.map((s) => prep(s.sql, s.params)));
      return rs.map((r) => ({ changes: r.meta?.changes ?? 0, lastRowId: r.meta?.last_row_id ?? 0 }));
    },
    async exec(sql) {
      const stmts = splitSql(sql);
      if (stmts.length) await d1.batch(stmts.map((s) => d1.prepare(s)));
    },
  };
}
