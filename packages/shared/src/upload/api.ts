import type { UploadInitRequest, UploadInitResponse, UploadCompleteResponse } from "../api-types";

/** HarborDrop 後端 API 的最小客戶端（瀏覽器與 Node 測試共用） */
export interface ClientOptions {
  /** 後端網址；瀏覽器同源時用 location.origin */
  baseUrl: string;
  /** 管理員 session token（可省略：瀏覽器用 cookie） */
  token?: string;
  fetch?: typeof fetch;
}

export class HdApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class HdClient {
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
  constructor(private opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetch = opts.fetch ?? ((...a) => fetch(...a));
  }
  headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.opts.token ? { Authorization: `Bearer ${this.opts.token}`, ...extra } : extra;
  }
  async json<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const r = await this.fetch(this.baseUrl + path, {
      method,
      credentials: "include",
      headers: this.headers({ ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) throw new HdApiError(r.status, data?.error?.code ?? "http_error", data?.error?.message ?? `HTTP ${r.status}`);
    return data as T;
  }
  initUpload(req: UploadInitRequest) {
    return this.json<UploadInitResponse>("POST", "/api/uploads", req);
  }
  sessionHeaders(s: UploadInitResponse, extra: Record<string, string> = {}) {
    return { "X-Upload-Token": s.uploadToken, ...extra };
  }
  action<T>(s: UploadInitResponse, name: string, body?: unknown) {
    return this.json<T>("POST", `/api/uploads/${s.sessionId}/action/${name}`, body, this.sessionHeaders(s));
  }
  complete(s: UploadInitResponse, body: unknown = {}) {
    return this.json<UploadCompleteResponse>("POST", `/api/uploads/${s.sessionId}/complete`, body, this.sessionHeaders(s));
  }
  abort(s: UploadInitResponse) {
    return this.json("DELETE", `/api/uploads/${s.sessionId}`, undefined, this.sessionHeaders(s));
  }
}
