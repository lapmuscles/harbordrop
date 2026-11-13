/** 指數退避重試（含隨機抖動）。每個分片／xorb 各自重試，失敗不影響其他分片 */
export interface RetryOptions {
  retries?: number; // 額外重試次數（預設 6）
  baseDelayMs?: number; // 預設 500
  maxDelayMs?: number; // 預設 30000
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  signal?: AbortSignal;
}

export class RetryableHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function backoffDelay(attempt: number, base = 500, max = 30_000): number {
  const exp = Math.min(max, base * 2 ** (attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(signal.reason ?? new Error("aborted"));
    });
  });

/** fn 拋出錯誤時重試；fn 自行決定哪些錯誤不重試（拋出 NonRetryableError） */
export class NonRetryableError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
  ) {
    super(message);
  }
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 6;
  for (let attempt = 1; ; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (error) {
      if (error instanceof NonRetryableError || opts.signal?.aborted || attempt > retries) throw error;
      const delayMs = backoffDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);
      opts.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, opts.signal);
    }
  }
}

/** 把 fetch 包成「非 2xx 依狀態碼決定是否重試」 */
export async function fetchChecked(f: typeof fetch, url: string, init: RequestInit, okStatuses: number[] = []): Promise<Response> {
  const r = await f(url, init);
  if (r.ok || okStatuses.includes(r.status)) return r;
  const text = await r.text().catch(() => "");
  const msg = `HTTP ${r.status}：${text.slice(0, 200)}`;
  if (isRetryableStatus(r.status)) throw new RetryableHttpError(r.status, msg);
  throw new NonRetryableError(msg);
}
