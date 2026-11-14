import type { DownloadOptions, DriverContext, DriverDefinition, FileEntry, ListResult, StorageDriver, UploadInitInput, UploadInitResult, UploadSessionView } from "../../types";
import { badRequest, HttpError } from "../../../core/errors";
import { contentDisposition, joinPath, normalizePath } from "../../util";
import { exchangeAuthCode, OAuthTokenCache } from "../oauth-token";

/**
 * Google Drive（Drive API v3）。
 * - 路徑 → 檔案 ID：自 root_folder_id 逐層以名稱查詢並快取（Drive 允許同名，取第一筆）
 * - 下載：經後端串流（Drive 下載需 Authorization 標頭），轉送 Range → 206
 * - 刪除：移到垃圾桶（trashed=true），可在 Google Drive 復原
 * - 上傳（protocol = "gdrive-resumable"）：後端建立 resumable session 時帶上瀏覽器的 Origin 標頭
 *   （Google 才會對該網域回 CORS），瀏覽器 PUT 256 KiB 倍數的分片，以 308 + Range 續傳。
 */

const KiB = 1024;
const MiB = 1024 * KiB;
export const GDRIVE_CHUNK_UNIT = 256 * KiB;
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GDRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,size,modifiedTime,md5Checksum,sha256Checksum,parents";
const ALL_DRIVES = "supportsAllDrives=true";

interface GDriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  rootFolderId: string;
  chunkSizeMB: number;
}

function parseConfig(c: Record<string, any>): GDriveConfig {
  if (!c.clientId) throw badRequest("Google Drive 需要 Client ID");
  return {
    clientId: String(c.clientId),
    clientSecret: String(c.clientSecret ?? ""),
    refreshToken: String(c.refreshToken ?? ""),
    rootFolderId: String(c.rootFolderId || "root").trim(),
    chunkSizeMB: Math.min(256, Math.max(1, Number(c.chunkSizeMB) || 8)),
  };
}

/** 分片大小：256 KiB 的倍數 */
export function gdriveChunkSize(preferredBytes: number): number {
  return Math.max(1, Math.floor(preferredBytes / GDRIVE_CHUNK_UNIT)) * GDRIVE_CHUNK_UNIT;
}

const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export class GDriveDriver implements StorageDriver {
  readonly type = "gdrive";
  readonly capabilities = {
    list: true,
    write: true,
    delete: true,
    mkdir: true,
    rename: true,
    copy: true,
    uploadProtocols: ["gdrive-resumable"],
    maxProxyUploadBytes: 5 * MiB,
  };
  private tokens: OAuthTokenCache;
  /** 路徑 → ID 快取（儲存內相對路徑） */
  private ids = new Map<string, string>();

  constructor(
    private cfg: GDriveConfig,
    private ctx: DriverContext,
  ) {
    this.tokens = new OAuthTokenCache({
      tokenUrl: TOKEN_URL,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      refreshToken: cfg.refreshToken,
      fetch: ctx.fetch,
      label: "Google Drive",
    });
    this.ids.set("/", cfg.rootFolderId);
  }

  private async api(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const token = await this.tokens.get();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    const r = await this.ctx.fetch(url, { ...init, headers });
    if (r.status === 401 && !retried) {
      this.tokens.invalidate();
      return this.api(url, init, true);
    }
    return r;
  }

  private async fail(r: Response, what: string): Promise<never> {
    const j: any = await r.json().catch(() => ({}));
    throw new HttpError(r.status === 404 ? 404 : 502, r.status === 404 ? "not_found" : "upstream_error", `Google Drive ${what}失敗：${j?.error?.message || `HTTP ${r.status}`}`);
  }

  private async json<T = any>(url: string, init: RequestInit, what: string): Promise<T> {
    const r = await this.api(url, init);
    if (!r.ok) await this.fail(r, what);
    return r.json() as Promise<T>;
  }

  private entry(f: any, path: string): FileEntry {
    const isDir = f.mimeType === FOLDER;
    return {
      name: path === "/" ? f.name ?? "/" : f.name,
      path,
      isDir,
      size: isDir || f.size === undefined ? undefined : Number(f.size),
      modifiedAt: f.modifiedTime ? Date.parse(f.modifiedTime) : undefined,
      mime: isDir ? undefined : f.mimeType,
      etag: f.md5Checksum,
      sha256: f.sha256Checksum,
    };
  }

  private parentOf(p: string) {
    return normalizePath(p.split("/").slice(0, -1).join("/"));
  }
  private baseOf(p: string) {
    return p.split("/").pop() ?? "";
  }

  /** 在資料夾中依名稱找子項目 */
  private async findChild(parentId: string, name: string): Promise<any | null> {
    const query = `'${q(parentId)}' in parents and name = '${q(name)}' and trashed = false`;
    const url = `${API}/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(`files(${FIELDS})`)}&pageSize=10&${ALL_DRIVES}&includeItemsFromAllDrives=true`;
    const j = await this.json<{ files: any[] }>(url, {}, "查詢");
    return j.files?.[0] ?? null;
  }

  /** 解析路徑 → 檔案中繼資料；不存在回傳 null */
  private async resolve(path: string): Promise<any | null> {
    const p = normalizePath(path);
    const cached = this.ids.get(p);
    if (cached) {
      const r = await this.api(`${API}/files/${encodeURIComponent(cached)}?fields=${encodeURIComponent(FIELDS + ",trashed")}&${ALL_DRIVES}`);
      if (r.ok) {
        const f: any = await r.json();
        if (!f.trashed) return f;
      } else if (r.status !== 404) await this.fail(r, "讀取項目");
      if (p === "/") throw new HttpError(404, "not_found", "Google Drive 根資料夾不存在");
      this.ids.delete(p);
    }
    if (p === "/") return null;
    const parent = await this.resolve(this.parentOf(p));
    if (!parent || parent.mimeType !== FOLDER) return null;
    const f = await this.findChild(parent.id, this.baseOf(p));
    if (f) this.ids.set(p, f.id);
    return f;
  }

  private forget(p: string) {
    const n = normalizePath(p);
    for (const k of [...this.ids.keys()]) if (k !== "/" && (k === n || k.startsWith(n + "/"))) this.ids.delete(k);
  }

  async testConnection() {
    try {
      const about = await this.json<any>(`${API}/about?fields=user,storageQuota`, {}, "連線");
      const root = await this.resolve("/");
      if (!root || root.mimeType !== FOLDER) return { ok: false, message: "根資料夾 ID 無效或不是資料夾" };
      const qt = about.storageQuota;
      const usage = qt?.limit ? `，已用 ${(Number(qt.usage) / 1024 ** 3).toFixed(1)} / ${(Number(qt.limit) / 1024 ** 3).toFixed(1)} GiB` : "";
      return { ok: true, message: `已連線到 Google Drive（${about.user?.emailAddress ?? about.user?.displayName ?? "帳號"}）${usage}` };
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) };
    }
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = normalizePath(path);
    const f = await this.resolve(p);
    return f ? this.entry(f, p) : null;
  }

  async list(path: string, opts: { cursor?: string; limit?: number } = {}): Promise<ListResult> {
    const p = normalizePath(path);
    const dir = await this.resolve(p);
    if (!dir) throw new HttpError(404, "not_found", "資料夾不存在");
    if (dir.mimeType !== FOLDER) throw badRequest("不是資料夾");
    const query = `'${q(dir.id)}' in parents and trashed = false`;
    const params = new URLSearchParams({
      q: query,
      fields: `nextPageToken,files(${FIELDS})`,
      pageSize: String(Math.min(1000, Math.max(1, opts.limit ?? 200))),
      orderBy: "folder,name",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (opts.cursor) params.set("pageToken", opts.cursor);
    const j = await this.json<{ files: any[]; nextPageToken?: string }>(`${API}/files?${params}`, {}, "列出目錄");
    const entries = (j.files ?? []).map((f) => {
      const cp = joinPath(p, f.name);
      this.ids.set(cp, f.id);
      return this.entry(f, cp);
    });
    return { entries, cursor: j.nextPageToken || undefined };
  }

  async download(path: string, opts: DownloadOptions = {}) {
    const f = await this.resolve(path);
    if (!f) throw new HttpError(404, "not_found", "檔案不存在");
    if (f.mimeType === FOLDER) throw badRequest("無法下載資料夾");
    if (String(f.mimeType).startsWith("application/vnd.google-apps.")) throw badRequest("Google 文件／試算表等原生格式不支援直接下載");
    const headers: Record<string, string> = {};
    const range = opts.request?.headers.get("range");
    if (range) headers.range = range;
    const r = await this.api(`${API}/files/${encodeURIComponent(f.id)}?alt=media&${ALL_DRIVES}`, { headers });
    if (!r.ok && r.status !== 206) {
      if (r.status === 416) return { kind: "response" as const, response: new Response(null, { status: 416, headers: { "content-range": `bytes */${f.size ?? 0}` } }) };
      await this.fail(r, "下載");
    }
    const out = new Headers();
    out.set("content-type", opts.mime || f.mimeType || r.headers.get("content-type") || "application/octet-stream");
    for (const h of ["content-length", "content-range", "etag", "last-modified"]) {
      const v = r.headers.get(h);
      if (v) out.set(h, v);
    }
    out.set("accept-ranges", "bytes");
    out.set("content-disposition", contentDisposition(opts.filename || f.name, !!opts.inline));
    return { kind: "response" as const, response: new Response(r.body, { status: r.status, headers: out }) };
  }

  /** 確保資料夾存在，回傳其 ID */
  private async ensureFolder(path: string): Promise<string> {
    const p = normalizePath(path);
    const f = await this.resolve(p);
    if (f) {
      if (f.mimeType !== FOLDER) throw badRequest(`「${p}」已存在且不是資料夾`);
      return f.id;
    }
    const parentId = await this.ensureFolder(this.parentOf(p));
    const created = await this.json<any>(
      `${API}/files?fields=${encodeURIComponent(FIELDS)}&${ALL_DRIVES}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: this.baseOf(p), mimeType: FOLDER, parents: [parentId] }) },
      "建立資料夾",
    );
    this.ids.set(p, created.id);
    return created.id;
  }

  async mkdir(path: string) {
    await this.ensureFolder(path);
  }

  async put(path: string, body: ReadableStream<Uint8Array> | Uint8Array, opts: { size: number; mime?: string }) {
    const p = normalizePath(path);
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    const mime = opts.mime || "application/octet-stream";
    const existing = await this.resolve(p);
    const parentId = await this.ensureFolder(this.parentOf(p));
    const boundary = "hd" + Math.random().toString(36).slice(2);
    const meta = existing ? { name: this.baseOf(p) } : { name: this.baseOf(p), parents: [parentId], mimeType: mime };
    const head = new TextEncoder().encode(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`);
    const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
    const all = new Uint8Array(head.length + bytes.length + tail.length);
    all.set(head);
    all.set(bytes, head.length);
    all.set(tail, head.length + bytes.length);
    const url = existing
      ? `${UPLOAD_API}/files/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=${encodeURIComponent(FIELDS)}&${ALL_DRIVES}`
      : `${UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(FIELDS)}&${ALL_DRIVES}`;
    const f = await this.json<any>(url, { method: existing ? "PATCH" : "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body: all as BodyInit }, "上傳");
    this.ids.set(p, f.id);
    return this.entry(f, p);
  }

  async delete(paths: string[]) {
    for (const path of paths) {
      const p = normalizePath(path);
      if (p === "/") throw badRequest("不可刪除根目錄");
      const f = await this.resolve(p);
      if (!f) continue;
      const r = await this.api(`${API}/files/${encodeURIComponent(f.id)}?${ALL_DRIVES}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trashed: true }),
      });
      if (!r.ok && r.status !== 404) await this.fail(r, "刪除");
      this.forget(p);
    }
  }

  async rename(from: string, to: string) {
    const src = normalizePath(from);
    const dst = normalizePath(to);
    const f = await this.resolve(src);
    if (!f) throw new HttpError(404, "not_found", "來源不存在");
    const params = new URLSearchParams({ fields: FIELDS, supportsAllDrives: "true" });
    if (this.parentOf(src) !== this.parentOf(dst)) {
      const newParent = await this.ensureFolder(this.parentOf(dst));
      params.set("addParents", newParent);
      params.set("removeParents", (f.parents ?? []).join(","));
    }
    await this.json(`${API}/files/${encodeURIComponent(f.id)}?${params}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: this.baseOf(dst) }) }, "重新命名／移動");
    this.forget(src);
    this.ids.set(dst, f.id);
  }

  async copy(from: string, to: string) {
    const src = normalizePath(from);
    const dst = normalizePath(to);
    const f = await this.resolve(src);
    if (!f) throw new HttpError(404, "not_found", "來源不存在");
    if (f.mimeType === FOLDER) throw badRequest("Google Drive 不支援複製資料夾");
    const parentId = await this.ensureFolder(this.parentOf(dst));
    const c = await this.json<any>(
      `${API}/files/${encodeURIComponent(f.id)}/copy?fields=${encodeURIComponent(FIELDS)}&${ALL_DRIVES}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: this.baseOf(dst), parents: [parentId] }) },
      "複製",
    );
    this.ids.set(dst, c.id);
  }

  async initUpload(input: UploadInitInput): Promise<UploadInitResult> {
    const p = normalizePath(input.path);
    const mime = input.mime || "application/octet-stream";
    const existing = await this.resolve(p);
    if (existing?.mimeType === FOLDER) throw badRequest("目的路徑是資料夾");
    const parentId = await this.ensureFolder(this.parentOf(p));
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": mime,
      "x-upload-content-length": String(input.size),
    };
    // 關鍵：Google 依建立 session 時的 Origin 決定之後分片請求的 CORS 回應
    if (input.origin) headers.origin = input.origin;
    const url = existing
      ? `${UPLOAD_API}/files/${encodeURIComponent(existing.id)}?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}&${ALL_DRIVES}`
      : `${UPLOAD_API}/files?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}&${ALL_DRIVES}`;
    const meta = existing ? { name: this.baseOf(p) } : { name: this.baseOf(p), parents: [parentId], mimeType: mime };
    const r = await this.api(url, { method: existing ? "PATCH" : "POST", headers, body: JSON.stringify(meta) });
    if (!r.ok) await this.fail(r, "建立上傳工作階段");
    const uploadUrl = r.headers.get("location");
    if (!uploadUrl) throw new HttpError(502, "upstream_error", "Google Drive 未回傳上傳網址");
    const chunkSize = gdriveChunkSize(input.partSize ?? this.cfg.chunkSizeMB * MiB);
    return {
      protocol: "gdrive-resumable",
      partSize: chunkSize,
      client: { uploadUrl, chunkSize },
      meta: { uploadUrl, parentId, replaceId: existing?.id ?? null },
    };
  }

  async completeUpload(session: UploadSessionView, body: any) {
    const p = normalizePath(session.objectPath);
    let f: any = null;
    const id = typeof body?.id === "string" ? body.id : null;
    if (id) {
      const r = await this.api(`${API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FIELDS + ",trashed")}&${ALL_DRIVES}`);
      if (r.ok) {
        const c: any = await r.json();
        // 驗證：必須是本工作階段的目的位置，避免瀏覽器指定任意檔案
        if (!c.trashed && c.name === this.baseOf(p) && (c.parents ?? []).includes(session.meta?.parentId)) f = c;
      }
    }
    if (!f) {
      this.forget(p);
      f = await this.resolve(p);
    }
    if (!f) throw badRequest("Google Drive 上找不到已上傳的檔案，上傳可能尚未完成");
    if (Number(f.size ?? 0) !== session.size) throw badRequest(`檔案大小不符（預期 ${session.size}，實際 ${f.size}）`);
    this.ids.set(p, f.id);
    return { entry: this.entry(f, p) };
  }

  async abortUpload(session: UploadSessionView) {
    const url = session.meta?.uploadUrl;
    if (url) await this.ctx.fetch(url, { method: "DELETE" }).catch(() => {});
  }
}

export const gdriveDriver: DriverDefinition = {
  type: "gdrive",
  label: "Google Drive",
  description: "Drive API v3；瀏覽器以 resumable upload 直傳分片，下載經後端串流（支援 Range）",
  fields: [
    { key: "clientId", label: "Client ID", type: "string", required: true, help: "Google Cloud Console 的 OAuth 用戶端 ID（網頁應用程式）" },
    { key: "clientSecret", label: "Client Secret", type: "secret", required: true },
    { key: "refreshToken", label: "Refresh Token", type: "secret", help: "可留空，儲存後按「OAuth 授權」自動取得" },
    { key: "rootFolderId", label: "根資料夾 ID", type: "string", default: "root", placeholder: "root", help: "資料夾網址最後一段；root = 我的雲端硬碟" },
    { key: "chunkSizeMB", label: "分片大小（MB）", type: "number", default: 8, help: "自動調整為 256 KiB 的倍數" },
  ],
  oauth: {
    tokenField: "refreshToken",
    authorizeUrl({ config, redirectUri, state }) {
      const cfg = parseConfig(config);
      const u = new URL(AUTH_URL);
      u.search = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GDRIVE_SCOPE,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
      }).toString();
      return u.href;
    },
    exchangeCode({ config, redirectUri, code, fetch }) {
      const cfg = parseConfig(config);
      return exchangeAuthCode({ tokenUrl: TOKEN_URL, clientId: cfg.clientId, clientSecret: cfg.clientSecret, code, redirectUri, fetch, label: "Google Drive" });
    },
  },
  create(config, ctx) {
    return new GDriveDriver(parseConfig(config), ctx);
  },
};
