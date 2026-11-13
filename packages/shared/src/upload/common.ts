import { backoffDelay, isRetryableStatus, type RetryOptions } from "./retry";

/** 續傳紀錄：以內容雜湊（xorb）或 `sessionId:part` 為鍵，記錄已成功上傳的單位 */
export interface ResumeStore {
  has(key: string): boolean | Promise<boolean>;
  add(key: string): void | Promise<void>;
}

export class MemoryResumeStore implements ResumeStore {
  keys = new Set<string>();
  has(k: string) {
    return this.keys.has(k);
  }
  add(k: string) {
    this.keys.add(k);
  }
}

/** 瀏覽器用：localStorage（只存鍵，不存資料） */
export class LocalStorageResumeStore implements ResumeStore {
  constructor(private ns: string) {}
  private load(): Set<string> {
    try {
      return new Set(JSON.parse(localStorage.getItem(this.ns) ?? "[]"));
    } catch {
      return new Set();
    }
  }
  has(k: string) {
    return this.load().has(k);
  }
  add(k: string) {
    const s = this.load();
    s.add(k);
    localStorage.setItem(this.ns, JSON.stringify([...s].slice(-5000)));
  }
}

export type UnitKind = "xorb" | "shard" | "part" | "dedup" | "control" | "other";

export interface AttemptRecord {
  kind: UnitKind;
  id: string;
  index: number;
  attempt: number;
  ok: boolean;
  status?: number;
  bytes: number;
  ms: number;
  error?: string;
}

export interface UploadStats {
  protocol: string;
  attempts: AttemptRecord[];
  skipped: number;
  startedAt: number;
  finishedAt?: number;
}

export interface ProgressInfo {
  phase: "hashing" | "uploading" | "committing" | "done";
  /** 0–1 */
  fraction: number;
  loaded?: number;
  total: number;
}

export interface UploadHooks {
  onProgress?(p: ProgressInfo): void;
  onRetry?(info: { kind: UnitKind; id: string; attempt: number; delayMs: number; error: string }): void;
  /** 測試用：回傳毫秒數 = 在該毫秒後中斷此請求（模擬中途斷線） */
  faultInjector?(info: { kind: UnitKind; id: string; index: number; attempt: number }): number | undefined;
  resume?: ResumeStore;
  signal?: AbortSignal;
  retry?: RetryOptions;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 帶重試的單一請求：網路錯誤或可重試狀態碼（408/429/5xx）→ 指數退避重試；
 * 其他非 2xx 直接回傳 Response 讓呼叫端處理。body 必須可重複使用（Uint8Array／Blob／字串）。
 */
export async function retryingFetch(
  base: typeof fetch,
  url: string,
  init: RequestInit,
  unit: { kind: UnitKind; id: string; index: number },
  hooks: UploadHooks,
  stats: UploadStats,
): Promise<Response> {
  const retries = hooks.retry?.retries ?? 6;
  const bytes = (init.body as any)?.byteLength ?? (init.body as any)?.size ?? 0;
  for (let attempt = 1; ; attempt++) {
    hooks.signal?.throwIfAborted();
    const ac = new AbortController();
    const onAbort = () => ac.abort(hooks.signal!.reason);
    hooks.signal?.addEventListener("abort", onAbort);
    const faultMs = hooks.faultInjector?.({ ...unit, attempt });
    const faultTimer = faultMs !== undefined ? setTimeout(() => ac.abort(new Error(`模擬中斷（${faultMs}ms）`)), faultMs) : undefined;
    const t0 = Date.now();
    let err: string;
    try {
      const r = await base(url, { ...init, signal: ac.signal });
      if (r.ok || !isRetryableStatus(r.status) || attempt > retries) {
        stats.attempts.push({ ...unit, attempt, ok: r.ok, status: r.status, bytes, ms: Date.now() - t0 });
        return r;
      }
      err = `HTTP ${r.status}`;
      await r.body?.cancel().catch(() => {});
      stats.attempts.push({ ...unit, attempt, ok: false, status: r.status, bytes, ms: Date.now() - t0, error: err });
    } catch (e: any) {
      if (hooks.signal?.aborted) throw e;
      err = String(ac.signal.reason?.message ?? e?.cause?.message ?? e?.message ?? e);
      stats.attempts.push({ ...unit, attempt, ok: false, bytes, ms: Date.now() - t0, error: err });
      if (attempt > retries) throw e;
    } finally {
      clearTimeout(faultTimer);
      hooks.signal?.removeEventListener("abort", onAbort);
    }
    const delayMs = backoffDelay(attempt, hooks.retry?.baseDelayMs, hooks.retry?.maxDelayMs);
    hooks.onRetry?.({ kind: unit.kind, id: unit.id, attempt, delayMs, error: err });
    await sleep(delayMs);
  }
}

export function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}
