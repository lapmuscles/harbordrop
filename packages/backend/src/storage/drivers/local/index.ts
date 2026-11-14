import type { DownloadOptions, DriverContext, DriverDefinition, FileEntry, ListResult, StorageDriver } from "../../types";
import { badRequest, HttpError } from "../../../core/errors";
import { contentDisposition, guessMime, joinPath, normalizePath } from "../../util";

/**
 * 本機磁碟驅動（僅 Node 部署可用）。
 * 上傳：protocol = "proxy"，整檔經後端 put()，以暫存檔寫入後改名，避免半截檔。
 * 安全：所有路徑先正規化（拒絕 ..），再解析成絕對路徑並確認位於根目錄內；
 * 既有路徑另以 realpath 檢查，防止符號連結指到根目錄外。
 *
 * 注意：node:fs 等模組以「非字面量」動態 import 載入，Workers 打包時不會被解析，
 * 因此本檔可安全地出現在 Workers 版的 registry 中。
 */

const MiB = 1024 * 1024;

type FsP = typeof import("node:fs/promises");
type PathMod = typeof import("node:path");
type FsMod = typeof import("node:fs");
type StreamMod = typeof import("node:stream");

interface NodeMods {
  fsp: FsP;
  fs: FsMod;
  path: PathMod;
  stream: StreamMod;
}

let modsPromise: Promise<NodeMods> | undefined;
function loadNode(): Promise<NodeMods> {
  // 以變數組出模組名稱，避免打包器（wrangler/esbuild）在 Workers 版靜態解析
  const n = (m: string) => "node:" + m;
  modsPromise ??= Promise.all([
    import(/* @vite-ignore */ n("fs/promises")),
    import(/* @vite-ignore */ n("fs")),
    import(/* @vite-ignore */ n("path")),
    import(/* @vite-ignore */ n("stream")),
  ]).then(([fsp, fs, path, stream]) => ({ fsp, fs, path, stream }) as NodeMods);
  return modsPromise;
}

export const WORKERS_UNSUPPORTED_MESSAGE = "本機儲存僅支援 Node（Docker／自架）部署；Cloudflare Workers 沒有檔案系統，請改用 S3、WebDAV 等渠道";

interface LocalConfig {
  root: string;
}

/** 解析 Range 標頭（只支援單一區段） */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start: number, end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

/** 正規化並把 .. 轉成 400 path_traversal 錯誤 */
function safeNorm(p: string): string {
  try {
    return normalizePath(p);
  } catch {
    throw badRequest("路徑不可包含 ..", "path_traversal");
  }
}

export class LocalDriver implements StorageDriver {
  readonly type = "local";
  readonly capabilities;

  constructor(
    private cfg: LocalConfig,
    private ctx: DriverContext,
  ) {
    const ok = ctx.platform === "node";
    this.capabilities = {
      list: ok,
      write: ok,
      delete: ok,
      mkdir: ok,
      rename: ok,
      copy: ok,
      uploadProtocols: ok ? ["proxy"] : [],
      maxProxyUploadBytes: ok ? 50 * 1024 * MiB : undefined,
    };
  }

  private async mods(): Promise<NodeMods> {
    if (this.ctx.platform !== "node") throw new HttpError(501, "platform_unsupported", WORKERS_UNSUPPORTED_MESSAGE);
    return loadNode();
  }

  private rootAbs?: string;
  private async root(): Promise<string> {
    if (this.rootAbs) return this.rootAbs;
    const { path } = await this.mods();
    const base = this.ctx.dataDir ?? process.cwd();
    this.rootAbs = path.resolve(base, this.cfg.root);
    return this.rootAbs;
  }

  /** 儲存內路徑 → 絕對路徑；保證位於根目錄內 */
  async abs(p: string): Promise<string> {
    const { path, fsp } = await this.mods();
    const norm = safeNorm(p);
    if (norm.includes("\0")) throw badRequest("路徑含有非法字元", "path_traversal");
    const root = await this.root();
    const full = path.resolve(root, "." + norm);
    const inside = (x: string, r: string) => x === r || x.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
    if (!inside(full, root)) throw badRequest("路徑超出根目錄", "path_traversal");
    // 符號連結檢查：找出最近存在的祖先，確認其真實路徑仍在根目錄內
    let realRoot: string;
    try {
      realRoot = await fsp.realpath(root);
    } catch {
      return full; // 根目錄尚不存在（testConnection 會回報）
    }
    let probe = full;
    for (;;) {
      try {
        const real = await fsp.realpath(probe);
        if (!inside(real, realRoot)) throw badRequest("路徑超出根目錄", "path_traversal");
        break;
      } catch (e: any) {
        if (e instanceof HttpError) throw e;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    return full;
  }

  private toEntry(p: string, st: import("node:fs").Stats): FileEntry {
    const name = p === "/" ? "" : p.split("/").pop()!;
    return {
      name,
      path: p,
      isDir: st.isDirectory(),
      size: st.isDirectory() ? undefined : st.size,
      modifiedAt: st.mtimeMs,
      mime: st.isDirectory() ? undefined : guessMime(name),
      etag: st.isDirectory() ? undefined : `${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}`,
    };
  }

  async testConnection() {
    if (this.ctx.platform !== "node") return { ok: false, message: WORKERS_UNSUPPORTED_MESSAGE };
    try {
      const { fsp, fs } = await this.mods();
      const root = await this.root();
      await fsp.mkdir(root, { recursive: true });
      await fsp.access(root, fs.constants.R_OK | fs.constants.W_OK);
      return { ok: true, message: `可讀寫：${root}` };
    } catch (e: any) {
      return { ok: false, message: `無法存取根目錄：${e.message}` };
    }
  }

  async stat(path: string): Promise<FileEntry | null> {
    const { fsp } = await this.mods();
    const full = await this.abs(path);
    try {
      return this.toEntry(safeNorm(path), await fsp.stat(full));
    } catch (e: any) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return null;
      throw e;
    }
  }

  async list(path: string): Promise<ListResult> {
    const { fsp, path: pm } = await this.mods();
    const base = safeNorm(path);
    const full = await this.abs(base);
    let names: string[];
    try {
      names = await fsp.readdir(full);
    } catch (e: any) {
      if (e.code === "ENOENT") throw new HttpError(404, "not_found", "找不到資料夾");
      if (e.code === "ENOTDIR") throw badRequest("不是資料夾");
      throw e;
    }
    const entries: FileEntry[] = [];
    for (const name of names) {
      try {
        const st = await fsp.stat(pm.join(full, name));
        entries.push(this.toEntry(joinPath(base, name), st));
      } catch {
        /* 壞掉的符號連結等：略過 */
      }
    }
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return { entries };
  }

  async download(path: string, opts: DownloadOptions = {}) {
    const { fs, stream } = await this.mods();
    const p = safeNorm(path);
    const st = await this.stat(p);
    if (!st || st.isDir) throw new HttpError(404, "not_found", "找不到檔案");
    const size = st.size ?? 0;
    const full = await this.abs(p);
    const h = new Headers({
      "accept-ranges": "bytes",
      "content-type": opts.mime || st.mime || "application/octet-stream",
      "content-disposition": contentDisposition(opts.filename ?? st.name, !!opts.inline),
      etag: `"${st.etag}"`,
      "last-modified": new Date(st.modifiedAt ?? Date.now()).toUTCString(),
    });
    let range = parseRange(opts.request?.headers.get("range"), size);
    const ifRange = opts.request?.headers.get("if-range");
    if (range && ifRange && ifRange.replace(/"/g, "") !== st.etag) range = null;
    if (range === "invalid") {
      return { kind: "response" as const, response: new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } }) };
    }
    const toWeb = (s: import("node:fs").ReadStream) => stream.Readable.toWeb(s) as unknown as ReadableStream<Uint8Array>;
    if (range) {
      h.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
      h.set("content-length", String(range.end - range.start + 1));
      const body = toWeb(fs.createReadStream(full, { start: range.start, end: range.end }));
      return { kind: "response" as const, response: new Response(body, { status: 206, headers: h }) };
    }
    h.set("content-length", String(size));
    const body = size === 0 ? null : toWeb(fs.createReadStream(full));
    return { kind: "response" as const, response: new Response(body, { status: 200, headers: h }) };
  }

  async put(path: string, body: ReadableStream<Uint8Array> | Uint8Array, opts: { size: number; mime?: string }) {
    const { fsp, fs, path: pm, stream } = await this.mods();
    const p = safeNorm(path);
    if (p === "/") throw badRequest("路徑不可為根目錄");
    const full = await this.abs(p);
    const existing = await this.stat(p);
    if (existing?.isDir) throw new HttpError(409, "conflict", "同名資料夾已存在");
    await fsp.mkdir(pm.dirname(full), { recursive: true });
    const tmp = `${full}.harbordrop-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.part`;
    try {
      if (body instanceof Uint8Array) {
        await fsp.writeFile(tmp, body);
      } else {
        const { pipeline } = await import(/* @vite-ignore */ "node:" + "stream/promises");
        await pipeline(stream.Readable.fromWeb(body as any), fs.createWriteStream(tmp));
      }
      const st = await fsp.stat(tmp);
      if (opts.size >= 0 && st.size !== opts.size) throw badRequest(`檔案大小不符：收到 ${st.size}，應為 ${opts.size}`, "size_mismatch");
      await fsp.rename(tmp, full);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
    return (await this.stat(p))!;
  }

  async delete(paths: string[]) {
    const { fsp } = await this.mods();
    for (const path of paths) {
      const p = safeNorm(path);
      if (p === "/") throw badRequest("不可刪除根目錄");
      await fsp.rm(await this.abs(p), { recursive: true, force: true });
    }
  }

  async mkdir(path: string) {
    const { fsp } = await this.mods();
    const p = safeNorm(path);
    const st = await this.stat(p);
    if (st && !st.isDir) throw new HttpError(409, "conflict", "同名檔案已存在");
    await fsp.mkdir(await this.abs(p), { recursive: true });
  }

  private async checkMove(from: string, to: string) {
    const f = safeNorm(from);
    const t = safeNorm(to);
    if (f === "/" || t === "/") throw badRequest("不可對根目錄操作");
    if (t === f || t.startsWith(f + "/")) throw badRequest("目的地不可位於來源之內");
    if (!(await this.stat(f))) throw new HttpError(404, "not_found", "找不到來源");
    const { fsp, path: pm } = await this.mods();
    const dst = await this.abs(t);
    await fsp.mkdir(pm.dirname(dst), { recursive: true });
    return { src: await this.abs(f), dst };
  }

  async rename(from: string, to: string) {
    const { fsp } = await this.mods();
    const { src, dst } = await this.checkMove(from, to);
    await fsp.rename(src, dst);
  }

  async copy(from: string, to: string) {
    const { fsp } = await this.mods();
    const { src, dst } = await this.checkMove(from, to);
    await fsp.cp(src, dst, { recursive: true, force: true });
  }
}

export const localDriver: DriverDefinition = {
  type: "local",
  label: "本機磁碟",
  description: "伺服器上的資料夾（僅 Node／Docker 部署）；檔案經後端上傳",
  platforms: ["node"],
  fields: [{ key: "root", label: "根目錄", type: "string", required: true, default: "files", help: "相對路徑以資料目錄（DATA_DIR）為基準；也可填絕對路徑" }],
  create: (config, ctx) => {
    if (ctx.platform !== "node") throw new HttpError(400, "platform_unsupported", WORKERS_UNSUPPORTED_MESSAGE);
    const root = String(config.root ?? "").trim();
    if (!root) throw badRequest("本機儲存需要根目錄");
    return new LocalDriver({ root }, ctx);
  },
};
