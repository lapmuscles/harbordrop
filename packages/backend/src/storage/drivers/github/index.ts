import type { DownloadOptions, DriverContext, DriverDefinition, FileEntry, ListResult, StorageDriver } from "../../types";
import { badRequest, HttpError } from "../../../core/errors";
import { contentDisposition, guessMime, joinPath, normalizePath } from "../../util";

/**
 * GitHub 儲存庫驅動（REST Contents API）。
 * 上傳：protocol = "proxy"，後端讀完整檔後以 base64 PUT /contents；覆寫既有檔需帶 sha。
 * GitHub 單檔上限 100 MB；Workers 因記憶體（128 MB，base64 會膨脹約 1.33 倍）另限 25 MB。
 * Git 沒有空資料夾，因此不支援 mkdir；刪除資料夾會逐檔刪除（每檔一個 commit）。
 */

const MiB = 1024 * 1024;
export const GITHUB_MAX_FILE_BYTES = 100 * MiB;
const WORKERS_MAX_BYTES = 25 * MiB;
const API = "https://api.github.com";

interface GithubConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  root: string;
}

function parseConfig(c: Record<string, any>): GithubConfig {
  const owner = String(c.owner ?? "").trim();
  const repo = String(c.repo ?? "").trim();
  if (!owner || !repo) throw badRequest("GitHub 需要擁有者（owner）與儲存庫（repo）");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw badRequest("GitHub 擁有者或儲存庫名稱格式錯誤");
  return {
    owner,
    repo,
    branch: String(c.branch || "main").trim(),
    token: String(c.token ?? ""),
    root: normalizePath(c.root || "/"),
  };
}

/** Uint8Array → base64（分段避免堆疊溢位） */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  return btoa(bin);
}

async function readAll(body: ReadableStream<Uint8Array> | Uint8Array, limit: number): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "too_large", `檔案過大：GitHub 單檔上限為 ${limit / MiB} MB`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

interface GhItem {
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;
  path: string;
  sha: string;
  size: number;
}

interface GhTree {
  sha: string;
  truncated?: boolean;
  tree: { path: string; type: "blob" | "tree" | "commit"; sha: string; size?: number }[];
}

/** Contents API 列目錄的筆數上限 */
export const CONTENTS_LIST_LIMIT = 1000;

const sortEntries = (e: FileEntry[]) => e.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));

export class GithubDriver implements StorageDriver {
  readonly type = "github";
  readonly capabilities;

  constructor(
    private cfg: GithubConfig,
    private ctx: DriverContext,
  ) {
    this.capabilities = {
      list: true,
      write: true,
      delete: true,
      mkdir: false,
      rename: false,
      copy: false,
      uploadProtocols: ["proxy"],
      maxProxyUploadBytes: ctx.platform === "workers" ? WORKERS_MAX_BYTES : GITHUB_MAX_FILE_BYTES,
    };
  }

  /** 儲存內路徑 → 儲存庫內路徑（不以 / 開頭；根目錄為空字串） */
  repoPath(path: string): string {
    return joinPath(this.cfg.root, normalizePath(path)).slice(1);
  }

  private contentsUrl(repoPath: string, withRef = true): string {
    const enc = repoPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const base = `${API}/repos/${this.cfg.owner}/${this.cfg.repo}/contents${enc ? "/" + enc : ""}`;
    return withRef ? `${base}?ref=${encodeURIComponent(this.cfg.branch)}` : base;
  }

  private gh(url: string, init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "HarborDrop",
      ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
      ...(init.headers ?? {}),
    };
    return this.ctx.fetch(url, { ...init, headers });
  }

  private async fail(r: Response, what: string): Promise<never> {
    let msg = "";
    try {
      msg = ((await r.json()) as any)?.message ?? "";
    } catch {
      /* 非 JSON */
    }
    if (r.status === 401) throw new HttpError(502, "upstream_auth", `GitHub ${what} 失敗：權杖無效或已過期`);
    if (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0") throw new HttpError(429, "rate_limited", `GitHub ${what} 失敗：已達 API 速率上限，請稍後再試`);
    if (r.status === 403) throw new HttpError(502, "upstream_auth", `GitHub ${what} 失敗：權杖沒有此儲存庫的寫入權限（${msg}）`);
    if (r.status === 404) throw new HttpError(404, "not_found", `GitHub ${what} 失敗：找不到儲存庫、分支或路徑`);
    if (r.status === 413) throw new HttpError(413, "too_large", `GitHub ${what} 失敗：檔案過大（上限 100 MB）`);
    throw new HttpError(502, "upstream_error", `GitHub ${what} 失敗（${r.status}）：${msg.slice(0, 200)}`);
  }

  private toEntry(path: string, it: GhItem): FileEntry {
    const isDir = it.type === "dir";
    const name = path === "/" ? "" : path.split("/").pop()!;
    return { name, path, isDir, size: isDir ? undefined : it.size, mime: isDir ? undefined : guessMime(name), etag: it.sha };
  }

  /** 讀取 contents；檔案回傳物件、資料夾回傳陣列、不存在回傳 null */
  private async contents(path: string): Promise<GhItem | GhItem[] | null> {
    const r = await this.gh(this.contentsUrl(this.repoPath(path)));
    if (r.status === 404) return null;
    if (!r.ok) await this.fail(r, "讀取");
    return (await r.json()) as GhItem | GhItem[];
  }

  async testConnection() {
    try {
      const r = await this.gh(`${API}/repos/${this.cfg.owner}/${this.cfg.repo}`);
      if (!r.ok) await this.fail(r, "連線");
      const repo = (await r.json()) as { permissions?: { push?: boolean }; full_name?: string };
      const b = await this.gh(`${API}/repos/${this.cfg.owner}/${this.cfg.repo}/branches/${encodeURIComponent(this.cfg.branch)}`);
      if (b.status === 404) return { ok: false, message: `分支不存在：${this.cfg.branch}` };
      if (!b.ok) await this.fail(b, "讀取分支");
      if (repo.permissions && repo.permissions.push === false) return { ok: false, message: "已連線，但權杖沒有寫入（push）權限" };
      return { ok: true, message: `已連線：${repo.full_name ?? `${this.cfg.owner}/${this.cfg.repo}`}（${this.cfg.branch}）` };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = normalizePath(path);
    const c = await this.contents(p);
    if (!c) return null;
    if (Array.isArray(c)) return { name: p === "/" ? "" : p.split("/").pop()!, path: p, isDir: true };
    return this.toEntry(p, c);
  }

  async list(path: string): Promise<ListResult> {
    const base = normalizePath(path);
    const c = await this.contents(base);
    if (!c) {
      if (base === "/") return { entries: [] }; // 根目錄尚無檔案
      throw new HttpError(404, "not_found", "找不到資料夾");
    }
    if (!Array.isArray(c)) throw badRequest("不是資料夾");
    // Contents API 每個資料夾最多回傳 1000 筆；達上限時改用 Git Trees API 取得完整列表
    if (c.length >= CONTENTS_LIST_LIMIT) return { entries: sortEntries(await this.listViaTrees(base)) };
    const entries = c
      .filter((it) => it.type === "file" || it.type === "dir")
      .map((it) => this.toEntry(joinPath(base, it.name), it))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return { entries };
  }

  /** 以 Git Trees API 列出資料夾：由分支取得根樹，逐層找到目標樹（每層一次請求），再列出其直接子項目 */
  private async listViaTrees(base: string): Promise<FileEntry[]> {
    const treeUrl = (sha: string) => `${API}/repos/${this.cfg.owner}/${this.cfg.repo}/git/trees/${encodeURIComponent(sha)}`;
    const getTree = async (sha: string): Promise<GhTree> => {
      const r = await this.gh(treeUrl(sha));
      if (!r.ok) await this.fail(r, "讀取目錄樹");
      return (await r.json()) as GhTree;
    };
    const b = await this.gh(`${API}/repos/${this.cfg.owner}/${this.cfg.repo}/branches/${encodeURIComponent(this.cfg.branch)}`);
    if (!b.ok) await this.fail(b, "讀取分支");
    const rootSha = ((await b.json()) as { commit?: { commit?: { tree?: { sha?: string } } } }).commit?.commit?.tree?.sha;
    if (!rootSha) throw new HttpError(502, "upstream_error", "GitHub 讀取分支失敗：缺少根目錄樹");
    let tree = await getTree(rootSha);
    for (const seg of this.repoPath(base).split("/").filter(Boolean)) {
      const next = tree.tree.find((t) => t.path === seg && t.type === "tree");
      if (!next) throw new HttpError(404, "not_found", "找不到資料夾");
      tree = await getTree(next.sha);
    }
    return tree.tree
      .filter((t) => t.type === "blob" || t.type === "tree")
      .map((t) => {
        const isDir = t.type === "tree";
        return { name: t.path, path: joinPath(base, t.path), isDir, size: isDir ? undefined : t.size, mime: isDir ? undefined : guessMime(t.path), etag: t.sha };
      });
  }

  async download(path: string, opts: DownloadOptions = {}) {
    const p = normalizePath(path);
    const headers: Record<string, string> = { accept: "application/vnd.github.raw+json" };
    const range = opts.request?.headers.get("range");
    if (range) headers.range = range;
    const r = await this.gh(this.contentsUrl(this.repoPath(p)), { headers });
    if (r.status === 404) throw new HttpError(404, "not_found", "找不到檔案");
    if (r.status === 416) return { kind: "response" as const, response: new Response(null, { status: 416 }) };
    if (!r.ok) await this.fail(r, "下載");
    const name = p.split("/").pop()!;
    const h = new Headers();
    for (const k of ["content-length", "content-range", "etag", "last-modified"]) {
      const v = r.headers.get(k);
      if (v) h.set(k, v);
    }
    if (r.headers.get("accept-ranges")) h.set("accept-ranges", r.headers.get("accept-ranges")!);
    h.set("content-type", opts.mime || guessMime(name));
    h.set("content-disposition", contentDisposition(opts.filename ?? name, !!opts.inline));
    return { kind: "response" as const, response: new Response(r.body, { status: r.status, headers: h }) };
  }

  private async currentSha(p: string): Promise<string | undefined> {
    const c = await this.contents(p);
    if (!c) return undefined;
    if (Array.isArray(c)) throw new HttpError(409, "conflict", "同名資料夾已存在");
    return c.sha;
  }

  async put(path: string, body: ReadableStream<Uint8Array> | Uint8Array, opts: { size: number; mime?: string }) {
    const p = normalizePath(path);
    if (p === "/") throw badRequest("路徑不可為根目錄");
    const limit = this.capabilities.maxProxyUploadBytes;
    if (opts.size > limit) {
      throw new HttpError(
        413,
        "too_large",
        opts.size > GITHUB_MAX_FILE_BYTES
          ? `檔案過大：GitHub 單檔上限為 100 MB（此檔 ${(opts.size / MiB).toFixed(1)} MB），請改用其他渠道或 Git LFS`
          : `檔案過大：Workers 上的 GitHub 上傳上限為 ${limit / MiB} MB，較大的檔案請改用 Node 部署`,
      );
    }
    const bytes = await readAll(body, limit);
    const content = bytesToBase64(bytes);
    const repoPath = this.repoPath(p);
    let sha = await this.currentSha(p);
    for (let attempt = 0; ; attempt++) {
      const r = await this.gh(this.contentsUrl(repoPath, false), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: `HarborDrop：${sha ? "更新" : "上傳"} ${repoPath}`, content, branch: this.cfg.branch, ...(sha ? { sha } : {}) }),
      });
      // sha 過期（同時有人改檔）→ 重新取得 sha 再試一次
      if ((r.status === 409 || r.status === 422) && attempt === 0) {
        const fresh = await this.currentSha(p);
        if (fresh !== sha) {
          sha = fresh;
          continue;
        }
      }
      if (!r.ok) await this.fail(r, "上傳");
      const j = (await r.json()) as { content?: GhItem };
      const it = j.content ?? { type: "file", name: p.split("/").pop()!, path: repoPath, sha: "", size: bytes.byteLength };
      return { ...this.toEntry(p, it), size: it.size ?? bytes.byteLength, modifiedAt: Date.now() };
    }
  }

  private async deleteFile(p: string, sha: string) {
    const repoPath = this.repoPath(p);
    const r = await this.gh(this.contentsUrl(repoPath, false), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: `HarborDrop：刪除 ${repoPath}`, sha, branch: this.cfg.branch }),
    });
    if (!r.ok && r.status !== 404) await this.fail(r, "刪除");
  }

  async delete(paths: string[]) {
    for (const path of paths) {
      const p = normalizePath(path);
      if (p === "/") throw badRequest("不可刪除根目錄");
      const c = await this.contents(p);
      if (!c) continue;
      if (!Array.isArray(c)) {
        await this.deleteFile(p, c.sha);
        continue;
      }
      // 資料夾：遞迴逐檔刪除
      const stack: [string, GhItem[]][] = [[p, c]];
      while (stack.length) {
        const [dir, items] = stack.pop()!;
        for (const it of items) {
          const child = joinPath(dir, it.name);
          if (it.type === "dir") {
            const sub = await this.contents(child);
            if (Array.isArray(sub)) stack.push([child, sub]);
          } else {
            await this.deleteFile(child, it.sha);
          }
        }
      }
    }
  }
}

export const githubDriver: DriverDefinition = {
  type: "github",
  label: "GitHub 儲存庫",
  description: "以 GitHub Contents API 存放檔案（單檔上限 100 MB；每次寫入產生一個 commit）",
  fields: [
    { key: "owner", label: "擁有者", type: "string", required: true, placeholder: "octocat" },
    { key: "repo", label: "儲存庫", type: "string", required: true, placeholder: "my-files" },
    { key: "branch", label: "分支", type: "string", default: "main" },
    { key: "token", label: "存取權杖", type: "secret", required: true, help: "Fine-grained token，需要此儲存庫的 Contents 讀寫權限" },
    { key: "root", label: "根目錄", type: "string", default: "/" },
  ],
  create: (config, ctx) => new GithubDriver(parseConfig(config), ctx),
};
