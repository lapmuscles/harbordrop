/**
 * 極薄的資料庫抽象層：同一段 SQL（`?` 佔位符）在 Cloudflare D1 與 better-sqlite3 上執行。
 * 所有模組只依賴這個介面，不得直接 import D1 或 better-sqlite3。
 */
export type SqlValue = string | number | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastRowId: number;
}

export interface Db {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  /** 交易式批次（D1 batch／SQLite transaction） */
  batch(statements: { sql: string; params?: unknown[] }[]): Promise<RunResult[]>;
  /** 執行多條以分號分隔、無參數的 SQL（遷移用） */
  exec(sql: string): Promise<void>;
}

/** 把 undefined / boolean 正規化成 SQLite 可接受的值 */
export function normParams(params: unknown[] = []): SqlValue[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    return p as SqlValue;
  });
}

/** 依分號切割 SQL（略過註解；本專案的遷移不含 trigger，故可安全切割） */
export function splitSql(sql: string): string[] {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}
