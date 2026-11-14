import type { DriverContext, DriverDefinition, FileEntry, ListResult, StorageDriver, UploadInitInput, UploadInitResult, UploadSessionView } from "../../types";
import { badRequest, HttpError } from "../../../core/errors";
import { joinPath, normalizePath } from "../../util";
import { exchangeAuthCode, OAuthTokenCache } from "../oauth-token";

/**
 * OneDrive / SharePoint（Microsoft Graph）。
 * - 認證：refresh_token 換 access token（快取於驅動實例）；region=cn 使用世紀互聯端點
 * - 下載：回傳 @microsoft.graph.downloadUrl 轉址（短效預先授權網址，位元組不經後端）
 * - 上傳（protocol = "graph-upload-session"）：後端 createUploadSession → 回傳 uploadUrl，
 *   瀏覽器依序直傳 320 KiB 倍數的分片（Content-Range），可隨時以 GET uploadUrl 查 nextExpectedRanges 續傳。
 *   uploadUrl 本身即為授權（不可帶 Authorization 標頭），不含任何供應商憑證。
 */

const KiB = 1024;
const MiB = 1024 * KiB;
export const GRAPH_CHUNK_UNIT = 320 * KiB;
const MAX_CHUNK = 60 * MiB;
const SIMPLE_UPLOAD_MAX = 4 * MiB;
export const ONEDRIVE_SCOPE = "offline_access Files.ReadWrite.All";

const ENDPOINTS = {
  global: { graph: "https://graph.microsoft.com/v1.0", login: "https://login.microsoftonline.com" },
  cn: { graph: "https://microsoftgraph.chinacloudapi.cn/v1.0", login: "https://login.chinacloudapi.cn" },
} as const;

interface OneDriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  region: "global" | "cn";
  driveType: "personal" | "business";
  driveId: string;
  root: string;
  chunkSizeMB: number;
}

function parseConfig(c: Record<string, any>): OneDriveConfig {
  if (!c.clientId) throw badRequest("OneDrive 需要 Client ID");
  const region = c.region === "cn" ? "cn" : "global";
  return {
    clientId: String(c.clientId),
    clientSecret: String(c.clientSecret ?? ""),
    refreshToken: String(c.refreshToken ?? ""),
    region,
    driveType: c.driveType === "business" ? "business" : "personal",
    driveId: String(c.driveId ?? "").trim(),
    root: normalizePath(c.root || "/"),
    chunkSizeMB: Math.min(60, Math.max(1, Number(c.chunkSizeMB) || 10)),
  };
}

/** 分片大小：320 KiB 的倍數、不超過 60 MiB */
export function graphChunkSize(preferredBytes: number): number {
  const units = Math.max(1, Math.floor(Math.min(preferredBytes, MAX_CHUNK) / GRAPH_CHUNK_UNIT));
  return units * GRAPH_CHUNK_UNIT;
}

const tenant = (cfg: { driveType?: string }) => (cfg.driveType === "business" ? "organizations" : "common");
const tokenUrl = (cfg: { region?: string; driveType?: string }) => `${ENDPOINTS[cfg.region === "cn" ? "cn" : "global"].login}/${tenant(cfg)}/oauth2/v2.0/token`;
const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OneDriveDriver implements StorageDriver {
  readonly type = "onedrive";
  readonly capabilities = {
    list: true,
    write: true,
    delete: true,
    mkdir: true,
    rename: true,
    copy: true,
    uploadProtocols: ["graph-upload-session"],
    maxProxyUploadBytes: SIMPLE_UPLOAD_MAX,
  };
  private tokens: OAuthTokenCache;
  private graph: string;
  private driveIdCache?: string;
  /** 測試可縮短複製輪詢間隔 */
  copyPollMs = 1000;

  constructor(
    private cfg: OneDriveConfig,
    private ctx: DriverContext,
  ) {
    this.graph = ENDPOINTS[cfg.region].graph;
    this.tokens = new OAuthTokenCache({
      tokenUrl: tokenUrl(cfg),
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      refreshToken: cfg.refreshToken,
      scope: ONEDRIVE_SCOPE,
      fetch: ctx.fetch,
      label: "OneDrive",
    });
  }

  private get drive() {
    return this.cfg.driveId ? `${this.graph}/drives/${encodeURIComponent(this.cfg.driveId)}` : `${this.graph}/me/drive`;
  }
  private full(p: string) {
    return joinPath(this.cfg.root, normalizePath(p));
  }
  private rel(full: string) {
    const r = this.cfg.root === "/" ? full : full.slice(this.cfg.root.length);
    return normalizePath(r);
  }
  /** 依完整路徑組 item URL；suffix 例如 children、content、createUploadSession */
  private itemUrl(full: string, suffix?: string) {
    if (full === "/") return `${this.drive}/root${suffix ? `/${suffix}` : ""}`;
    return `${this.drive}/root:${encPath(full)}:${suffix ? `/${suffix}` : ""}`;
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
    throw new HttpError(r.status === 404 ? 404 : 502, r.status === 404 ? "not_found" : "upstream_error", `OneDrive ${what}失敗：${j?.error?.message || `HTTP ${r.status}`}`);
  }

  private entry(item: any, parentFull?: string): FileEntry {
    const full = parentFull !== undefined ? joinPath(parentFull, item.name) : undefined;
    return {
      name: item.name,
      path: full !== undefined ? this.rel(full) : "/",
      isDir: !!item.folder,
      size: item.folder ? undefined : item.size,
      modifiedAt: item.lastModifiedDateTime ? Date.parse(item.lastModifiedDateTime) : undefined,
      mime: item.file?.mimeType,
      etag: item.eTag,
      sha256: item.file?.hashes?.sha256Hash?.toLowerCase(),
    };
  }

  private async getItem(full: string): Promise<any | null> {
    const r = await this.api(this.itemUrl(full));
    if (r.status === 404) return null;
    if (!r.ok) await this.fail(r, "讀取項目");
    return r.json();
  }

  private parent(full: string) {
    return normalizePath(full.split("/").slice(0, -1).join("/"));
  }
  private base(full: string) {
    return full.split("/").pop() ?? "";
  }

  async testConnection() {
    try {
      const r = await this.api(this.drive);
      if (!r.ok) await this.fail(r, "連線");
      const d: any = await r.json();
      const q = d.quota;
      const usage = q?.total ? `，已用 ${(q.used / 1024 ** 3).toFixed(1)} / ${(q.total / 1024 ** 3).toFixed(1)} GiB` : "";
      return { ok: true, message: `已連線到 ${d.driveType ?? "OneDrive"}（${d.owner?.user?.displayName ?? d.id}）${usage}` };
    } catch (e: any) {
      return { ok: false, message: e?.message ?? String(e) };
    }
  }

  async stat(path: string): Promise<FileEntry | null> {
    const full = this.full(path);
    const item = await this.getItem(full);
    if (!item) return null;
    const e = this.entry(item, full === "/" ? undefined : this.parent(full));
    if (full === this.cfg.root) return { ...e, path: "/", name: e.name };
    return e;
  }

  async list(path: string, opts: { cursor?: string; limit?: number } = {}): Promise<ListResult> {
    const full = this.full(path);
    let url: string;
    if (opts.cursor) {
      if (!opts.cursor.startsWith(this.graph + "/")) throw badRequest("無效的分頁游標");
      url = opts.cursor;
    } else {
      const top = Math.min(1000, Math.max(1, opts.limit ?? 200));
      url = `${this.itemUrl(full, "children")}?$top=${top}`;
    }
    const r = await this.api(url);
    if (!r.ok) await this.fail(r, "列出目錄");
    const j: any = await r.json();
    return { entries: (j.value ?? []).map((it: any) => this.entry(it, full)), cursor: j["@odata.nextLink"] || undefined };
  }

  async download(path: string) {
    const item = await this.getItem(this.full(path));
    if (!item) throw new HttpError(404, "not_found", "檔案不存在");
    if (item.folder) throw badRequest("無法下載資料夾");
    const url = item["@microsoft.graph.downloadUrl"];
    if (!url) throw new HttpError(502, "upstream_error", "OneDrive 未提供下載網址");
    return { kind: "redirect" as const, url, expiresAt: Date.now() + 50 * 60 * 1000 };
  }

  async put(path: string, body: ReadableStream<Uint8Array> | Uint8Array, opts: { size: number; mime?: string }) {
    if (opts.size > SIMPLE_UPLOAD_MAX) throw badRequest("超過 OneDrive 簡易上傳上限（4 MiB），請使用瀏覽器直傳");
    const full = this.full(path);
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    const r = await this.api(`${this.itemUrl(full, "content")}?@microsoft.graph.conflictBehavior=replace`, {
      method: "PUT",
      headers: { "content-type": opts.mime || "application/octet-stream" },
      body: bytes as BodyInit,
    });
    if (!r.ok) await this.fail(r, "上傳");
    return this.entry(await r.json(), this.parent(full));
  }

  async delete(paths: string[]) {
    for (const p of paths) {
      const full = this.full(p);
      if (full === this.cfg.root || full === "/") throw badRequest("不可刪除根目錄");
      const r = await this.api(this.itemUrl(full), { method: "DELETE" });
      if (!r.ok && r.status !== 404) await this.fail(r, "刪除");
    }
  }

  private async mkdirFull(full: string): Promise<void> {
    if (full === "/") return;
    const create = () =>
      this.api(this.itemUrl(this.parent(full), "children"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: this.base(full), folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
      });
    let r = await create();
    if (r.status === 404) {
      await this.mkdirFull(this.parent(full));
      r = await create();
    }
    if (r.status === 409) {
      const it = await this.getItem(full);
      if (it?.folder) return;
      throw badRequest("同名檔案已存在");
    }
    if (!r.ok) await this.fail(r, "建立資料夾");
  }

  async mkdir(path: string) {
    await this.mkdirFull(this.full(path));
  }

  private async driveId(): Promise<string> {
    if (this.cfg.driveId) return this.cfg.driveId;
    if (!this.driveIdCache) {
      const r = await this.api(this.drive);
      if (!r.ok) await this.fail(r, "讀取磁碟資訊");
      this.driveIdCache = ((await r.json()) as any).id;
    }
    return this.driveIdCache!;
  }

  private async folderId(full: string): Promise<string> {
    await this.mkdirFull(full);
    const it = await this.getItem(full);
    if (!it?.id) throw new HttpError(502, "upstream_error", "無法取得目的資料夾");
    return it.id;
  }

  async rename(from: string, to: string) {
    const src = this.full(from);
    const dst = this.full(to);
    const body: any = { name: this.base(dst) };
    if (this.parent(src) !== this.parent(dst)) body.parentReference = { id: await this.folderId(this.parent(dst)) };
    const r = await this.api(this.itemUrl(src), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) await this.fail(r, "重新命名／移動");
  }

  async copy(from: string, to: string) {
    const src = this.full(from);
    const dst = this.full(to);
    const parentReference = { driveId: await this.driveId(), id: await this.folderId(this.parent(dst)) };
    const r = await this.api(`${this.itemUrl(src, "copy")}?@microsoft.graph.conflictBehavior=replace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentReference, name: this.base(dst) }),
    });
    if (r.status !== 202 && !r.ok) await this.fail(r, "複製");
    const monitor = r.headers.get("location");
    if (!monitor) return;
    // 複製為非同步作業：輪詢監控網址（不需授權標頭）
    for (let i = 0; i < 120; i++) {
      const m = await this.ctx.fetch(monitor, { redirect: "manual" });
      if (m.status === 303 || m.status === 302) return;
      const j: any = await m.json().catch(() => ({}));
      if (j.status === "completed" || j.resourceId) return;
      if (j.status === "failed") throw new HttpError(502, "upstream_error", `OneDrive 複製失敗：${j.error?.message ?? "未知錯誤"}`);
      await sleep(this.copyPollMs);
    }
    throw new HttpError(504, "timeout", "OneDrive 複製逾時（作業可能仍在背景進行）");
  }

  async initUpload(input: UploadInitInput): Promise<UploadInitResult> {
    const full = this.full(input.path);
    if (input.size === 0) {
      // 上傳工作階段不接受 0 位元組：後端直接建立空檔
      await this.put(input.path, new Uint8Array(0), { size: 0, mime: input.mime });
      return { protocol: "graph-upload-session", client: { done: true, size: 0 } };
    }
    const r = await this.api(this.itemUrl(full, "createUploadSession"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
    });
    if (!r.ok) await this.fail(r, "建立上傳工作階段");
    const j: any = await r.json();
    if (!j.uploadUrl) throw new HttpError(502, "upstream_error", "OneDrive 未回傳 uploadUrl");
    const chunkSize = graphChunkSize(input.partSize ?? this.cfg.chunkSizeMB * MiB);
    return {
      protocol: "graph-upload-session",
      partSize: chunkSize,
      client: { uploadUrl: j.uploadUrl, chunkSize, expiresAt: j.expirationDateTime ? Date.parse(j.expirationDateTime) : undefined },
      meta: { uploadUrl: j.uploadUrl },
    };
  }

  async completeUpload(session: UploadSessionView) {
    const e = await this.stat(session.objectPath);
    if (!e || e.isDir) throw badRequest("OneDrive 上找不到已上傳的檔案，上傳可能尚未完成");
    if (e.size !== session.size) throw badRequest(`檔案大小不符（預期 ${session.size}，實際 ${e.size}）`);
    return { entry: e };
  }

  async abortUpload(session: UploadSessionView) {
    const url = session.meta?.uploadUrl;
    if (url) await this.ctx.fetch(url, { method: "DELETE" }).catch(() => {});
  }
}

export const onedriveDriver: DriverDefinition = {
  type: "onedrive",
  label: "OneDrive / SharePoint",
  description: "Microsoft Graph；瀏覽器以上傳工作階段直傳分片，下載轉址至 OneDrive",
  fields: [
    { key: "region", label: "區域", type: "select", default: "global", options: [{ value: "global", label: "國際版" }, { value: "cn", label: "世紀互聯（中國）" }] },
    { key: "driveType", label: "帳號類型", type: "select", default: "personal", options: [{ value: "personal", label: "個人版" }, { value: "business", label: "商務版／學校" }] },
    { key: "clientId", label: "Client ID", type: "string", required: true, help: "Azure 應用程式註冊的應用程式（用戶端）識別碼" },
    { key: "clientSecret", label: "Client Secret", type: "secret", required: true },
    { key: "refreshToken", label: "Refresh Token", type: "secret", help: "可留空，儲存後按「OAuth 授權」自動取得" },
    { key: "driveId", label: "Drive ID", type: "string", placeholder: "留空 = 自己的 OneDrive", help: "SharePoint 文件庫或指定磁碟的 ID" },
    { key: "root", label: "根目錄", type: "string", default: "/", placeholder: "/HarborDrop" },
    { key: "chunkSizeMB", label: "分片大小（MB）", type: "number", default: 10, help: "自動調整為 320 KiB 的倍數，上限 60 MB" },
  ],
  oauth: {
    tokenField: "refreshToken",
    authorizeUrl({ config, redirectUri, state }) {
      const cfg = parseConfig(config);
      const u = new URL(`${ENDPOINTS[cfg.region].login}/${tenant(cfg)}/oauth2/v2.0/authorize`);
      u.search = new URLSearchParams({ client_id: cfg.clientId, response_type: "code", redirect_uri: redirectUri, response_mode: "query", scope: ONEDRIVE_SCOPE, state, prompt: "consent" }).toString();
      return u.href;
    },
    exchangeCode({ config, redirectUri, code, fetch }) {
      const cfg = parseConfig(config);
      return exchangeAuthCode({ tokenUrl: tokenUrl(cfg), clientId: cfg.clientId, clientSecret: cfg.clientSecret, code, redirectUri, scope: ONEDRIVE_SCOPE, fetch, label: "OneDrive" });
    },
  },
  create(config, ctx) {
    return new OneDriveDriver(parseConfig(config), ctx);
  },
};
