import type { DownloadOptions, DriverContext, DriverDefinition, FileEntry, ListResult, StorageDriver } from "../../types";
import { badRequest, HttpError } from "../../../core/errors";
import { contentDisposition, joinPath, normalizePath } from "../../util";

/**
 * WebDAV 用戶端驅動（連到外部 WebDAV 伺服器，例如 Nextcloud、群暉、Apache mod_dav）。
 * 上傳：protocol = "proxy"，整檔經後端 put()（Workers 受請求體上限限制）。
 * 下載：經後端代理，轉送 Range 標頭以支援續傳與影音拖曳。
 */

const MiB = 1024 * 1024;

interface WebDavConfig {
  url: string; // 伺服器基底 URL（不含結尾 /）
  username: string;
  password: string;
  root: string;
}

function parseConfig(c: Record<string, any>): WebDavConfig {
  if (!c.url) throw badRequest("WebDAV 需要伺服器網址");
  let u: URL;
  try {
    u = new URL(String(c.url));
  } catch {
    throw badRequest("WebDAV 伺服器網址格式錯誤");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw badRequest("WebDAV 伺服器網址必須是 http 或 https");
  return {
    url: String(c.url).replace(/\/+$/, ""),
    username: c.username ?? "",
    password: c.password ?? "",
    root: normalizePath(c.root || "/"),
  };
}

/** UTF-8 安全的 base64（btoa 只吃 Latin-1） */
export function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const xmlUnescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

/** 取出第一個符合的元素內容（忽略命名空間前綴，例如 d:href、D:href、lp1:getetag） */
function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "i").exec(xml);
  return m?.[1];
}
function tagAll(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "gi"))].map((m) => m[1]);
}
function hasTag(xml: string, name: string): boolean {
  return new RegExp(`<(?:[\\w-]+:)?${name}[\\s/>]`, "i").test(xml);
}

export interface DavResource {
  href: string; // 已解碼的絕對路徑（伺服器上的 URL path）
  isDir: boolean;
  size?: number;
  modifiedAt?: number;
  mime?: string;
  etag?: string;
}

/** 解析 PROPFIND 207 Multi-Status 回應 */
export function parseMultiStatus(xml: string): DavResource[] {
  const out: DavResource[] = [];
  for (const resp of tagAll(xml, "response")) {
    const rawHref = tag(resp, "href");
    if (!rawHref) continue;
    // 只取狀態為 200 的 propstat
    const propstats = tagAll(resp, "propstat");
    const okProps = propstats.filter((ps) => /\s200\s/.test(tag(ps, "status") ?? " 200 ")).join("") || resp;
    let href = xmlUnescape(rawHref.trim());
    try {
      href = new URL(href, "http://x").pathname;
    } catch {
      /* 保持原樣 */
    }
    try {
      href = decodeURIComponent(href);
    } catch {
      /* 非法編碼時保持原樣 */
    }
    const rt = tag(okProps, "resourcetype") ?? "";
    const len = tag(okProps, "getcontentlength");
    const lm = tag(okProps, "getlastmodified");
    const ct = tag(okProps, "getcontenttype");
    const et = tag(okProps, "getetag");
    const isDir = hasTag(rt, "collection");
    out.push({
      href,
      isDir,
      size: !isDir && len ? Number(len.trim()) : undefined,
      modifiedAt: lm ? Date.parse(lm.trim()) || undefined : undefined,
      mime: ct ? xmlUnescape(ct.trim()) : undefined,
      etag: et ? xmlUnescape(et.trim()).replace(/^W\//, "").replace(/"/g, "") : undefined,
    });
  }
  return out;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop>' +
  "<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/><d:getetag/>" +
  "</d:prop></d:propfind>";

const trimSlash = (s: string) => (s.length > 1 ? s.replace(/\/+$/, "") : s);

export class WebDavDriver implements StorageDriver {
  readonly type = "webdav";
  readonly capabilities = {
    list: true,
    write: true,
    delete: true,
    mkdir: true,
    rename: true,
    copy: true,
    uploadProtocols: ["proxy"],
    maxProxyUploadBytes: 95 * MiB,
  };
  private basePath: string; // 伺服器 URL 的 path 部分（已解碼、無結尾 /）

  constructor(
    private cfg: WebDavConfig,
    private ctx: DriverContext,
  ) {
    this.basePath = trimSlash(decodeURIComponent(new URL(cfg.url).pathname)) || "/";
  }

  /** 儲存內路徑 → 伺服器上的絕對路徑（已解碼） */
  private serverPath(path: string): string {
    return joinPath(this.basePath, this.cfg.root, normalizePath(path));
  }

  /** 儲存內路徑 → 完整 URL（每段編碼）；dir=true 時加結尾 /（部分伺服器對集合要求） */
  url(path: string, dir = false): string {
    const origin = new URL(this.cfg.url).origin;
    const sp = this.serverPath(path);
    const enc = sp === "/" ? "/" : sp.split("/").map(encodeURIComponent).join("/");
    return origin + enc + (dir && !enc.endsWith("/") ? "/" : "");
  }

  /** 伺服器 href → 儲存內路徑；不在根目錄下則回傳 null */
  private toStoragePath(href: string): string | null {
    const rootAbs = trimSlash(joinPath(this.basePath, this.cfg.root));
    const h = trimSlash(href.replace(/\/{2,}/g, "/")) || "/";
    if (rootAbs === "/") return normalizePath(h);
    if (h === rootAbs) return "/";
    if (!h.startsWith(rootAbs + "/")) return null;
    return normalizePath(h.slice(rootAbs.length));
  }

  private authHeaders(): Record<string, string> {
    if (!this.cfg.username && !this.cfg.password) return {};
    return { authorization: "Basic " + base64Utf8(`${this.cfg.username}:${this.cfg.password}`) };
  }

  private dav(url: string, init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}): Promise<Response> {
    return this.ctx.fetch(url, { ...init, headers: { ...this.authHeaders(), ...(init.headers ?? {}) } });
  }

  private async fail(r: Response, what: string): Promise<never> {
    const t = await r.text().catch(() => "");
    if (r.status === 401 || r.status === 403) throw new HttpError(502, "upstream_auth", `WebDAV ${what} 失敗：帳號或密碼錯誤，或沒有權限（${r.status}）`);
    if (r.status === 404) throw new HttpError(404, "not_found", `WebDAV ${what} 失敗：找不到路徑`);
    if (r.status === 413) throw new HttpError(413, "too_large", `WebDAV ${what} 失敗：檔案超過伺服器允許的大小`);
    if (r.status === 507) throw new HttpError(507, "insufficient_storage", `WebDAV ${what} 失敗：伺服器空間不足`);
    throw new HttpError(502, "upstream_error", `WebDAV ${what} 失敗（${r.status}）：${t.replace(/<[^>]+>/g, " ").trim().slice(0, 200)}`);
  }

  private async propfind(path: string, depth: "0" | "1"): Promise<DavResource[] | null> {
    const r = await this.dav(this.url(path, depth === "1"), {
      method: "PROPFIND",
      headers: { depth, "content-type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
    });
    if (r.status === 404) return null;
    if (r.status !== 207 && !r.ok) await this.fail(r, "PROPFIND");
    return parseMultiStatus(await r.text());
  }

  private toEntry(res: DavResource, path: string): FileEntry {
    const name = path === "/" ? "" : path.split("/").pop()!;
    return { name, path, isDir: res.isDir, size: res.size, modifiedAt: res.modifiedAt, mime: res.isDir ? undefined : res.mime, etag: res.etag };
  }

  async testConnection() {
    try {
      const res = await this.propfind("/", "0");
      if (!res) return { ok: false, message: `根目錄不存在：${this.cfg.root}` };
      if (res[0] && !res[0].isDir) return { ok: false, message: `根目錄不是資料夾：${this.cfg.root}` };
      return { ok: true, message: `已連線：${this.cfg.url}${this.cfg.root === "/" ? "" : this.cfg.root}` };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = normalizePath(path);
    const res = await this.propfind(p, "0");
    if (!res || res.length === 0) return null;
    return this.toEntry(res[0], p);
  }

  async list(path: string): Promise<ListResult> {
    const base = normalizePath(path);
    const res = await this.propfind(base, "1");
    if (!res) throw new HttpError(404, "not_found", "找不到資料夾");
    const entries: FileEntry[] = [];
    for (const r of res) {
      const sp = this.toStoragePath(r.href);
      if (sp === null || sp === base) continue; // 略過自身與根目錄外的項目
      const name = sp.split("/").pop()!;
      if (!name) continue;
      entries.push(this.toEntry(r, joinPath(base, name)));
    }
    return { entries };
  }

  async download(path: string, opts: DownloadOptions = {}) {
    const headers: Record<string, string> = {};
    const range = opts.request?.headers.get("range");
    if (range) headers.range = range;
    const ifRange = opts.request?.headers.get("if-range");
    if (ifRange) headers["if-range"] = ifRange;
    const r = await this.dav(this.url(path), { method: "GET", headers });
    if (r.status === 416) {
      return { kind: "response" as const, response: new Response(null, { status: 416, headers: { "content-range": r.headers.get("content-range") ?? "" } }) };
    }
    if (!r.ok) await this.fail(r, "下載");
    const h = new Headers();
    for (const k of ["content-length", "content-range", "etag", "last-modified"]) {
      const v = r.headers.get(k);
      if (v) h.set(k, v);
    }
    h.set("accept-ranges", r.headers.get("accept-ranges") ?? "bytes");
    h.set("content-type", opts.mime || r.headers.get("content-type") || "application/octet-stream");
    h.set("content-disposition", contentDisposition(opts.filename ?? normalizePath(path).split("/").pop()!, !!opts.inline));
    return { kind: "response" as const, response: new Response(r.body, { status: r.status, headers: h }) };
  }

  /** 逐層建立父資料夾（MKCOL；405 = 已存在） */
  private async ensureParents(path: string) {
    const segs = normalizePath(path).split("/").filter(Boolean);
    segs.pop();
    let cur = "/";
    for (const s of segs) {
      cur = joinPath(cur, s);
      const r = await this.dav(this.url(cur, true), { method: "MKCOL" });
      if (!r.ok && r.status !== 405) await this.fail(r, `建立資料夾 ${cur}`);
    }
  }

  async put(path: string, body: ReadableStream<Uint8Array> | Uint8Array, opts: { size: number; mime?: string }) {
    const p = normalizePath(path);
    if (p === "/") throw badRequest("路徑不可為根目錄");
    if (opts.size > this.capabilities.maxProxyUploadBytes) throw new HttpError(413, "too_large", `檔案過大：WebDAV 經後端上傳上限為 ${this.capabilities.maxProxyUploadBytes / MiB} MB`);
    // 串流只能讀一次：若可能需要重試（父資料夾不存在），先建父資料夾
    if (p.split("/").length > 2) await this.ensureParents(p);
    const r = await this.dav(this.url(p), {
      method: "PUT",
      body: body as BodyInit,
      headers: { "content-type": opts.mime || "application/octet-stream", "content-length": String(opts.size) },
      // @ts-expect-error Node 串流上傳需要 duplex
      duplex: "half",
    });
    if (!r.ok) await this.fail(r, "上傳");
    const entry = await this.stat(p).catch(() => null);
    return entry ?? { name: p.split("/").pop()!, path: p, isDir: false, size: opts.size, mime: opts.mime, modifiedAt: Date.now() };
  }

  async delete(paths: string[]) {
    for (const path of paths) {
      const p = normalizePath(path);
      if (p === "/") throw badRequest("不可刪除根目錄");
      const r = await this.dav(this.url(p), { method: "DELETE" });
      if (!r.ok && r.status !== 404) await this.fail(r, "刪除");
    }
  }

  async mkdir(path: string) {
    const p = normalizePath(path);
    if (p === "/") return;
    await this.ensureParents(p);
    const r = await this.dav(this.url(p, true), { method: "MKCOL" });
    if (r.status === 405) {
      const s = await this.stat(p);
      if (s?.isDir) return;
      throw new HttpError(409, "conflict", "同名檔案已存在");
    }
    if (!r.ok) await this.fail(r, "建立資料夾");
  }

  private async moveOrCopy(method: "MOVE" | "COPY", from: string, to: string) {
    const f = normalizePath(from);
    const t = normalizePath(to);
    if (f === "/" || t === "/") throw badRequest("不可對根目錄操作");
    if (t === f || t.startsWith(f + "/")) throw badRequest("目的地不可位於來源之內");
    const src = await this.stat(f);
    if (!src) throw new HttpError(404, "not_found", "找不到來源");
    await this.ensureParents(t);
    const r = await this.dav(this.url(f, src.isDir), {
      method,
      headers: { destination: this.url(t, src.isDir), overwrite: "T", ...(src.isDir ? { depth: "infinity" } : {}) },
    });
    if (!r.ok) await this.fail(r, method === "MOVE" ? "移動" : "複製");
  }

  rename(from: string, to: string) {
    return this.moveOrCopy("MOVE", from, to);
  }
  copy(from: string, to: string) {
    return this.moveOrCopy("COPY", from, to);
  }
}

export const webdavDriver: DriverDefinition = {
  type: "webdav",
  label: "WebDAV",
  description: "連線到外部 WebDAV 伺服器（Nextcloud、群暉、Apache 等）；檔案經後端上傳",
  fields: [
    { key: "url", label: "伺服器網址", type: "string", required: true, placeholder: "https://dav.example.com/remote.php/dav/files/me" },
    { key: "username", label: "使用者名稱", type: "string" },
    { key: "password", label: "密碼", type: "secret" },
    { key: "root", label: "根目錄", type: "string", default: "/", help: "伺服器網址之下的子資料夾" },
  ],
  create: (config, ctx) => new WebDavDriver(parseConfig(config), ctx),
};
