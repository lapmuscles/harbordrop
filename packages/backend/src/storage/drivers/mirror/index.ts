import type { DownloadOptions, DownloadTarget, DriverContext, DriverDefinition, FileEntry, ListResult, StorageDriver } from "../../types";
import { HttpError, badRequest } from "../../../core/errors";
import { guessMime, joinPath, normalizePath } from "../../util";

/**
 * mirror 驅動（唯讀鏡像）。
 *   type = http-index：解析 Apache／Nginx autoindex 的 HTML 目錄列表；url 為根目錄網址。
 *   type = github-releases：url 為 owner/repo（或 https://github.com/owner/repo）；
 *     根目錄列出各 release（以 tag 為資料夾名稱），資料夾內為該 release 的 assets。
 * 下載一律 302 轉址到來源網址；所有寫入能力皆關閉。
 */

export type MirrorType = "http-index" | "github-releases";

export interface MirrorConfig {
  url: string;
  type: MirrorType;
  token?: string;
}

const GH_API = "https://api.github.com";
const READONLY_CAPS = {
  list: true,
  write: false,
  delete: false,
  mkdir: false,
  rename: false,
  copy: false,
  uploadProtocols: [],
} as const;

const notFound = (msg = "找不到此路徑") => new HttpError(404, "not_found", msg);

function nameOf(p: string): string {
  return p === "/" ? "" : p.split("/").pop()!;
}
function parentOf(p: string): string {
  return p.slice(0, p.lastIndexOf("/")) || "/";
}

// ───────────────────────── http-index ─────────────────────────

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** 解析 "12K"、"1.5M"、"1234" → 位元組；"-" 或無法解析 → undefined */
export function parseSize(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i.exec(s.trim());
  if (!m) return undefined;
  const mul = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase() as "" | "K" | "M" | "G" | "T"];
  return Math.round(Number(m[1]) * mul);
}

/** 解析 autoindex 常見日期格式（UTC）：14-Nov-2026 01:02、2026-11-14 01:02 */
export function parseDate(s: string): number | undefined {
  let m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (mon === undefined) return undefined;
    return Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  }
  m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  return undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/**
 * 解析 autoindex HTML。dirUrl 為目錄網址（結尾 /），用來判斷連結是否為「直接子項目」。
 * 回傳的 name 已解碼；排除上層目錄、排序連結（?C=N;O=D）、外部連結與更深層的連結。
 */
export function parseAutoindex(html: string, dirUrl: string): { name: string; isDir: boolean; size?: number; modifiedAt?: number }[] {
  const base = new URL(dirUrl);
  const out = new Map<string, { name: string; isDir: boolean; size?: number; modifiedAt?: number }>();
  const re = /<a\s[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>[\s\S]*?<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const rawHref = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
    if (!rawHref || rawHref.startsWith("?") || rawHref.startsWith("#") || /^(mailto|javascript):/i.test(rawHref)) continue;
    let u: URL;
    try {
      u = new URL(rawHref, base);
    } catch {
      continue;
    }
    if (u.origin !== base.origin || u.search) continue;
    if (!u.pathname.startsWith(base.pathname)) continue; // 上層或其他目錄
    const rest = u.pathname.slice(base.pathname.length);
    if (!rest) continue;
    const isDir = rest.endsWith("/");
    const seg = isDir ? rest.slice(0, -1) : rest;
    if (!seg || seg.includes("/")) continue; // 更深層
    let name: string;
    try {
      name = decodeURIComponent(seg);
    } catch {
      continue;
    }
    if (name === "." || name === "..") continue;
    // 連結之後到下一個連結（或行尾）的文字：日期與大小
    const tailEnd = html.indexOf("<a", re.lastIndex);
    const tailRaw = html.slice(re.lastIndex, tailEnd === -1 ? undefined : Math.min(tailEnd, re.lastIndex + 400));
    const tail = decodeEntities(tailRaw.split(/\r?\n/)[0].replace(/<[^>]+>/g, " "));
    const modifiedAt = parseDate(tail);
    let size: number | undefined;
    if (!isDir) {
      const afterDate = tail.replace(/(\d{1,2}-[A-Za-z]{3}-\d{4}|\d{4}-\d{2}-\d{2})[ T]\d{1,2}:\d{2}(:\d{2})?/, " ");
      const tok = afterDate.split(/\s+/).find((t) => /^\d+(\.\d+)?[KMGT]?$/i.test(t));
      size = parseSize(tok);
    }
    if (!out.has(name)) out.set(name, { name, isDir, size, modifiedAt });
  }
  return [...out.values()];
}

class HttpIndexMirror implements StorageDriver {
  readonly type = "mirror";
  readonly capabilities = { ...READONLY_CAPS, uploadProtocols: [] as string[] };
  private root: string;

  constructor(
    url: string,
    private ctx: DriverContext,
  ) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw badRequest("鏡像網址不正確");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw badRequest("鏡像網址需為 http 或 https");
    u.search = "";
    u.hash = "";
    this.root = u.toString().replace(/\/+$/, "") + "/";
  }

  /** 儲存內路徑 → 來源網址（逐段編碼；資料夾加結尾 /） */
  urlFor(path: string, dir: boolean): string {
    const p = normalizePath(path);
    const enc = p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    return this.root + enc + (dir && enc ? "/" : "");
  }

  private async fetchDir(path: string): Promise<{ name: string; isDir: boolean; size?: number; modifiedAt?: number }[] | null> {
    const url = this.urlFor(path, true);
    const r = await this.ctx.fetch(url, { headers: { accept: "text/html", "user-agent": "HarborDrop" } });
    if (r.status === 404) return null;
    if (!r.ok) throw new HttpError(502, "upstream_error", `鏡像來源回應錯誤（${r.status}）`);
    const ct = r.headers.get("content-type") ?? "";
    if (ct && !/html/i.test(ct)) throw new HttpError(502, "upstream_error", "鏡像來源不是 HTML 目錄列表");
    return parseAutoindex(await r.text(), r.url || url);
  }

  async testConnection() {
    try {
      const items = await this.fetchDir("/");
      if (!items) return { ok: false, message: "找不到鏡像根目錄（404）" };
      return { ok: true, message: `已連線：根目錄有 ${items.length} 個項目` };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }

  async list(path: string): Promise<ListResult> {
    const base = normalizePath(path);
    const items = await this.fetchDir(base);
    if (!items) throw notFound("找不到資料夾");
    const entries: FileEntry[] = items
      .map((it) => ({
        name: it.name,
        path: joinPath(base, it.name),
        isDir: it.isDir,
        size: it.size,
        modifiedAt: it.modifiedAt,
        mime: it.isDir ? undefined : guessMime(it.name),
      }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return { entries };
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = normalizePath(path);
    if (p === "/") return { name: "", path: "/", isDir: true };
    const items = await this.fetchDir(parentOf(p));
    const it = items?.find((x) => x.name === nameOf(p));
    if (!it) return null;
    return { name: it.name, path: p, isDir: it.isDir, size: it.size, modifiedAt: it.modifiedAt, mime: it.isDir ? undefined : guessMime(it.name) };
  }

  async download(path: string, _opts: DownloadOptions = {}): Promise<DownloadTarget> {
    return { kind: "redirect", url: this.urlFor(path, false) };
  }
}

// ───────────────────────── github-releases ─────────────────────────

interface GhAsset {
  name: string;
  size: number;
  updated_at?: string;
  content_type?: string;
  browser_download_url: string;
}
interface GhRelease {
  tag_name: string;
  name?: string | null;
  draft?: boolean;
  published_at?: string | null;
  created_at?: string;
  assets: GhAsset[];
}

/** "owner/repo" 或 "https://github.com/owner/repo(.git)" → [owner, repo] */
export function parseRepo(input: string): [string, string] {
  const s = String(input ?? "").trim();
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(s);
  if (!m) throw badRequest("github-releases 的 url 需為 owner/repo 或 https://github.com/owner/repo");
  return [m[1], m[2]];
}

const ts = (s?: string | null) => (s ? Date.parse(s) || undefined : undefined);
const PER_PAGE = 100;

class GithubReleasesMirror implements StorageDriver {
  readonly type = "mirror";
  readonly capabilities = { ...READONLY_CAPS, uploadProtocols: [] as string[] };
  private owner: string;
  private repo: string;

  constructor(
    url: string,
    private token: string | undefined,
    private ctx: DriverContext,
  ) {
    [this.owner, this.repo] = parseRepo(url);
  }

  private async gh(path: string): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "HarborDrop",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const r = await this.ctx.fetch(`${GH_API}/repos/${this.owner}/${this.repo}${path}`, { headers });
    if (r.ok || r.status === 404) return r;
    if (r.status === 401) throw new HttpError(502, "upstream_auth", "GitHub 權杖無效或已過期");
    if (r.status === 403 || r.status === 429) throw new HttpError(429, "rate_limited", "GitHub API 已達速率上限，請稍後再試（可設定權杖提高上限）");
    throw new HttpError(502, "upstream_error", `GitHub API 回應錯誤（${r.status}）`);
  }

  private async release(tag: string): Promise<GhRelease | null> {
    const r = await this.gh(`/releases/tags/${encodeURIComponent(tag)}`);
    if (r.status === 404) return null;
    return (await r.json()) as GhRelease;
  }

  private relEntry(r: GhRelease): FileEntry {
    return { name: r.tag_name, path: "/" + r.tag_name, isDir: true, modifiedAt: ts(r.published_at ?? r.created_at) };
  }
  private assetEntry(tag: string, a: GhAsset): FileEntry {
    return { name: a.name, path: `/${tag}/${a.name}`, isDir: false, size: a.size, modifiedAt: ts(a.updated_at), mime: guessMime(a.name) };
  }

  async testConnection() {
    try {
      const r = await this.gh("");
      if (r.status === 404) return { ok: false, message: `找不到儲存庫：${this.owner}/${this.repo}` };
      return { ok: true, message: `已連線：${this.owner}/${this.repo}` };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }

  async list(path: string, opts: { cursor?: string; limit?: number } = {}): Promise<ListResult> {
    const p = normalizePath(path);
    const segs = p.split("/").filter(Boolean);
    if (segs.length === 0) {
      const page = Math.max(1, Number(opts.cursor) || 1);
      const r = await this.gh(`/releases?per_page=${PER_PAGE}&page=${page}`);
      if (r.status === 404) throw notFound("找不到儲存庫");
      const rels = ((await r.json()) as GhRelease[]).filter((x) => !x.draft && x.tag_name);
      const hasMore = /rel="next"/.test(r.headers.get("link") ?? "");
      return { entries: rels.map((x) => this.relEntry(x)), cursor: hasMore ? String(page + 1) : undefined };
    }
    if (segs.length === 1) {
      const rel = await this.release(segs[0]);
      if (!rel) throw notFound("找不到此 release");
      return { entries: rel.assets.map((a) => this.assetEntry(rel.tag_name, a)).sort((a, b) => a.name.localeCompare(b.name)) };
    }
    throw notFound("找不到資料夾");
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = normalizePath(path);
    const segs = p.split("/").filter(Boolean);
    if (segs.length === 0) return { name: "", path: "/", isDir: true };
    if (segs.length > 2) return null;
    const rel = await this.release(segs[0]);
    if (!rel) return null;
    if (segs.length === 1) return this.relEntry(rel);
    const a = rel.assets.find((x) => x.name === segs[1]);
    return a ? this.assetEntry(rel.tag_name, a) : null;
  }

  async download(path: string): Promise<DownloadTarget> {
    const segs = normalizePath(path).split("/").filter(Boolean);
    if (segs.length !== 2) throw badRequest("無法下載目錄");
    const rel = await this.release(segs[0]);
    const a = rel?.assets.find((x) => x.name === segs[1]);
    if (!a) throw notFound("找不到此檔案");
    return { kind: "redirect", url: a.browser_download_url };
  }
}

export const mirrorDriver: DriverDefinition = {
  type: "mirror",
  label: "鏡像（唯讀）",
  description: "唯讀鏡像：瀏覽 Apache／Nginx 目錄列表或 GitHub Releases，下載時轉址到來源。",
  readonly: true,
  fields: [
    {
      key: "type",
      label: "鏡像類型",
      type: "select",
      required: true,
      default: "http-index",
      options: [
        { value: "http-index", label: "HTTP 目錄列表（Apache／Nginx autoindex）" },
        { value: "github-releases", label: "GitHub Releases" },
      ],
    },
    {
      key: "url",
      label: "來源",
      type: "string",
      required: true,
      placeholder: "https://mirror.example.com/pub/ 或 owner/repo",
      help: "HTTP 目錄列表填根目錄網址；GitHub Releases 填 owner/repo",
    },
    { key: "token", label: "GitHub 權杖（選填）", type: "secret", help: "僅 GitHub Releases 使用，可提高 API 速率上限" },
  ],
  create(config, ctx) {
    const type = (config.type ?? "http-index") as MirrorType;
    const url = String(config.url ?? "").trim();
    if (!url) throw badRequest("請輸入鏡像來源");
    if (type === "http-index") return new HttpIndexMirror(url, ctx);
    if (type === "github-releases") return new GithubReleasesMirror(url, config.token ? String(config.token) : undefined, ctx);
    throw badRequest(`不支援的鏡像類型：${type}`);
  },
};
