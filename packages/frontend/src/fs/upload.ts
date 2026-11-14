import { HdApiError, PROTOCOLS, type HdClient, type ProtocolHandler, type UploadHooks } from "@harbordrop/shared/upload";
import type { UploadInitResponse } from "@harbordrop/shared";

/**
 * 檔案總管上傳流程（不依賴 DOM，前端與後端整合測試共用）：
 *   POST /api/fs/upload/init → 依協定直傳（@harbordrop/shared PROTOCOLS，沿用 /api/uploads/:id/action/*）→ POST /api/fs/upload/complete
 *   不支援直傳的儲存回 protocol=proxy → PUT /api/fs/upload/put?path=
 */
export type FsUploadInit = (UploadInitResponse & { actionBase: string; completeUrl: string; path: string }) | { protocol: "proxy"; putUrl: string };

export type ProxyPut = (url: string, file: Blob, headers: Record<string, string>, hooks: UploadHooks) => Promise<void>;

export interface FsUploadOptions extends UploadHooks {
  /** 額外標頭（例如目錄解鎖的 X-Fs-Token） */
  headers?: Record<string, string>;
  /** proxy 上傳實作；預設用 fetch（瀏覽器端改用 XHR 以取得進度） */
  proxyPut?: ProxyPut;
  /** 協定表（預設 PROTOCOLS；測試可注入） */
  protocols?: Record<string, ProtocolHandler>;
  onInit?(init: FsUploadInit): void;
}

export function fetchProxyPut(api: HdClient): ProxyPut {
  return async (url, file, headers, hooks) => {
    const r = await api.fetch(api.baseUrl + url, {
      method: "PUT",
      credentials: "include",
      headers: api.headers({ ...headers, ...((file as File).type ? { "Content-Type": (file as File).type } : {}) }),
      body: file,
      signal: hooks.signal,
    });
    if (!r.ok) {
      const d: any = await r.json().catch(() => null);
      throw new HdApiError(r.status, d?.error?.code ?? "http_error", d?.error?.message ?? `HTTP ${r.status}`);
    }
    hooks.onProgress?.({ phase: "uploading", fraction: 1, loaded: file.size, total: file.size });
  };
}

export async function fsUpload(api: HdClient, dir: string, file: Blob, filename: string, opts: FsUploadOptions = {}): Promise<{ protocol: string; path?: string }> {
  const headers = opts.headers ?? {};
  const mime = (file as File).type || undefined;
  const init = await api.json<FsUploadInit>("POST", "/api/fs/upload/init", { path: dir, filename, size: file.size, mime }, headers);
  opts.onInit?.(init);
  if (init.protocol === "proxy") {
    await (opts.proxyPut ?? fetchProxyPut(api))((init as { putUrl: string }).putUrl, file, headers, opts);
    opts.onProgress?.({ phase: "done", fraction: 1, total: file.size });
    return { protocol: "proxy" };
  }
  const s = init as Exclude<FsUploadInit, { protocol: "proxy" }>;
  const handler = (opts.protocols ?? PROTOCOLS)[s.protocol];
  if (!handler) throw new Error(`瀏覽器不支援上傳協定：${s.protocol}`);
  try {
    const { completeBody } = await handler(api, s, file, opts);
    opts.onProgress?.({ phase: "committing", fraction: 1, total: file.size });
    const done = await api.json<{ entry: { path: string } }>("POST", s.completeUrl || "/api/fs/upload/complete", { sessionId: s.sessionId, body: completeBody }, { ...headers, "X-Upload-Token": s.uploadToken });
    opts.onProgress?.({ phase: "done", fraction: 1, total: file.size });
    return { protocol: s.protocol, path: done.entry?.path };
  } catch (e) {
    if (opts.signal?.aborted) await api.abort(s).catch(() => {});
    throw e;
  }
}
