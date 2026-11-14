/**
 * 分片中繼（chunk-relay）共用層：Telegram、Discord 這類「只能收附件」的渠道。
 *
 * - 上傳：瀏覽器把檔案切成驅動指定大小的分片，逐片 POST /api/uploads/:id/chunk，
 *   後端把每片當成一個附件轉送到渠道，參照存進 relay_upload_chunks；完成時合併成 relay_objects 一列。
 * - 下載：依 relay_objects.chunks 逐片向渠道取回並串流串接，支援 Range（只取涵蓋的分片）。
 * - 列目錄／刪除／改名：一律以 relay_objects 為準（渠道本身沒有目錄）。
 */
import type { Db } from "../db/adapter";
import { badRequest, HttpError, notFound } from "../core/errors";
import { contentDisposition, normalizePath } from "./util";
import type {
  Capabilities,
  DownloadOptions,
  DownloadTarget,
  DriverContext,
  FileEntry,
  ListResult,
  StorageDriver,
  UploadInitInput,
  UploadInitResult,
  UploadSessionView,
} from "./types";

export type ChunkRef = Record<string, unknown>;

export interface RelayChunk {
  index: number;
  size: number;
  ref: ChunkRef;
}

/** 各渠道只需實作「送出一片／取回一片／刪除一片」 */
export interface RelayBackend {
  readonly type: string;
  /** 每片大小（位元組） */
  readonly chunkSize: number;
  testConnection(): Promise<{ ok: boolean; message: string }>;
  uploadChunk(name: string, data: Uint8Array): Promise<ChunkRef>;
  /**
   * 取回一片的 [start, end]（含）位元組。回傳的 Response 可以是 206（已依 Range 裁切）
   * 或 200（整片，由呼叫端自行略過前段）。
   */
  fetchChunk(ref: ChunkRef, range?: { start: number; end: number }): Promise<Response>;
  deleteChunk(ref: ChunkRef): Promise<void>;
}

interface ObjectRow {
  id: number;
  storage_id: number;
  path: string;
  size: number;
  mime: string | null;
  chunks: string;
  created_at: number;
}

export const RELAY_PROTOCOL = "chunk-relay";
export const MAX_PROXY_BYTES = 95 * 1024 * 1024;

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => "\\" + m);
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** 把渠道錯誤轉成給瀏覽器的狀態碼：429／5xx → 可重試；其他 → 502 */
export async function relayHttpError(label: string, r: Response): Promise<HttpError> {
  const text = await r.text().catch(() => "");
  let retryAfter: number | undefined;
  try {
    const j = JSON.parse(text);
    retryAfter = j?.parameters?.retry_after ?? j?.retry_after;
  } catch {}
  const status = r.status === 429 ? 429 : r.status >= 500 ? 503 : 502;
  const msg = `${label}失敗（HTTP ${r.status}）${retryAfter ? `，請 ${Math.ceil(retryAfter)} 秒後重試` : ""}：${text.slice(0, 200)}`;
  return new HttpError(status, "relay_error", msg);
}

export interface ByteRange {
  start: number;
  end: number; // 含
}

/** 解析單一 Range（bytes=a-b、bytes=a-、bytes=-n）；不合法回傳 "invalid"，沒有回傳 undefined */
export function parseRange(header: string | null | undefined, size: number): ByteRange | "invalid" | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

/** 從 Response 串流中略過 skip 位元組後取 take 位元組，逐塊交給 enqueue */
async function pipeSlice(res: Response, skip: number, take: number, enqueue: (b: Uint8Array) => void): Promise<void> {
  if (!res.body) throw new Error("渠道回應沒有內容");
  const reader = res.body.getReader();
  try {
    while (take > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      let v = value;
      if (skip > 0) {
        if (v.byteLength <= skip) {
          skip -= v.byteLength;
          continue;
        }
        v = v.subarray(skip);
        skip = 0;
      }
      if (v.byteLength > take) v = v.subarray(0, take);
      take -= v.byteLength;
      enqueue(v);
    }
    if (take > 0) throw new Error("渠道回傳的分片長度不足");
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** 依 Range 串接多個分片成一條串流 */
export function concatChunks(backend: RelayBackend, chunks: RelayChunk[], range: ByteRange): ReadableStream<Uint8Array> {
  const plan: { chunk: RelayChunk; start: number; end: number }[] = [];
  let offset = 0;
  for (const c of chunks) {
    const cs = offset;
    const ce = offset + c.size - 1;
    offset += c.size;
    if (c.size === 0 || ce < range.start || cs > range.end) continue;
    plan.push({ chunk: c, start: Math.max(range.start, cs) - cs, end: Math.min(range.end, ce) - cs });
  }
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= plan.length) return controller.close();
      const p = plan[i++];
      const whole = p.start === 0 && p.end === p.chunk.size - 1;
      const res = await backend.fetchChunk(p.chunk.ref, whole ? undefined : { start: p.start, end: p.end });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`取回第 ${p.chunk.index} 片失敗（HTTP ${res.status}）`);
      }
      const skip = res.status === 206 ? 0 : p.start;
      await pipeSlice(res, skip, p.end - p.start + 1, (b) => controller.enqueue(b));
    },
  });
}

/** 通用的分片中繼驅動 */
export class RelayDriver implements StorageDriver {
  readonly type: string;
  readonly capabilities: Capabilities = {
    list: true,
    write: true,
    delete: true,
    mkdir: false,
    rename: true,
    copy: false,
    uploadProtocols: [RELAY_PROTOCOL],
    maxProxyUploadBytes: MAX_PROXY_BYTES,
  };

  constructor(
    readonly backend: RelayBackend,
    private ctx: DriverContext,
    private opts: { concurrency?: number } = {},
  ) {
    this.type = backend.type;
  }

  private get db(): Db {
    if (!this.ctx.db) throw new HttpError(500, "relay_no_db", "分片中繼渠道需要資料庫");
    return this.ctx.db;
  }
  private get sid(): number {
    if (this.ctx.storageId == null) throw new HttpError(500, "relay_no_storage", "分片中繼渠道缺少儲存 ID");
    return this.ctx.storageId;
  }

  testConnection() {
    return this.backend.testConnection();
  }

  private async row(path: string): Promise<ObjectRow | null> {
    return this.db.first<ObjectRow>("SELECT * FROM relay_objects WHERE storage_id = ? AND path = ?", [this.sid, normalizePath(path)]);
  }

  private entry(r: ObjectRow): FileEntry {
    return { name: baseName(r.path), path: r.path, isDir: false, size: r.size, mime: r.mime ?? undefined, modifiedAt: r.created_at };
  }

  async stat(path: string): Promise<FileEntry | null> {
    const p = normalizePath(path);
    const r = await this.row(p);
    if (r) return this.entry(r);
    if (p === "/") return { name: "", path: "/", isDir: true };
    const child = await this.db.first("SELECT 1 FROM relay_objects WHERE storage_id = ? AND path LIKE ? ESCAPE '\\' LIMIT 1", [this.sid, likeEscape(p) + "/%"]);
    return child ? { name: baseName(p), path: p, isDir: true } : null;
  }

  async list(path: string, opts: { cursor?: string; limit?: number } = {}): Promise<ListResult> {
    const p = normalizePath(path);
    const prefix = p === "/" ? "/" : p + "/";
    const rows = await this.db.all<ObjectRow>(
      "SELECT id, storage_id, path, size, mime, '[]' AS chunks, created_at FROM relay_objects WHERE storage_id = ? AND path LIKE ? ESCAPE '\\' ORDER BY path",
      [this.sid, likeEscape(prefix) + "%"],
    );
    const dirs = new Map<string, FileEntry>();
    const files: FileEntry[] = [];
    for (const r of rows) {
      const rest = r.path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) files.push(this.entry(r));
      else {
        const name = rest.slice(0, slash);
        const d = dirs.get(name);
        if (!d) dirs.set(name, { name, path: prefix + name, isDir: true, modifiedAt: r.created_at });
        else d.modifiedAt = Math.max(d.modifiedAt ?? 0, r.created_at);
      }
    }
    const all = [...dirs.values(), ...files];
    const start = Number(opts.cursor ?? 0) || 0;
    const limit = opts.limit ?? 1000;
    const entries = all.slice(start, start + limit);
    return { entries, cursor: start + limit < all.length ? String(start + limit) : undefined };
  }

  async download(path: string, opts: DownloadOptions = {}): Promise<DownloadTarget> {
    const r = await this.row(path);
    if (!r) throw notFound("找不到檔案");
    const chunks = JSON.parse(r.chunks) as RelayChunk[];
    const headers = new Headers({
      "Content-Type": opts.mime ?? r.mime ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Content-Disposition": contentDisposition(opts.filename ?? baseName(r.path), opts.inline),
    });
    const range = parseRange(opts.request?.headers.get("range"), r.size);
    if (range === "invalid") {
      headers.set("Content-Range", `bytes */${r.size}`);
      return { kind: "response", response: new Response(null, { status: 416, headers }) };
    }
    if (r.size === 0) {
      headers.set("Content-Length", "0");
      return { kind: "response", response: new Response(new Uint8Array(0), { status: 200, headers }) };
    }
    const span = range ?? { start: 0, end: r.size - 1 };
    headers.set("Content-Length", String(span.end - span.start + 1));
    if (range) headers.set("Content-Range", `bytes ${span.start}-${span.end}/${r.size}`);
    const body = concatChunks(this.backend, chunks, span);
    return { kind: "response", response: new Response(body, { status: range ? 206 : 200, headers }) };
  }

  private async deleteRefs(refs: ChunkRef[]) {
    for (const ref of refs) await this.backend.deleteChunk(ref).catch(() => {});
  }

  /** 寫入（或覆寫）一筆檔案清單；覆寫時刪除舊分片 */
  private async saveObject(path: string, size: number, mime: string | undefined | null, chunks: RelayChunk[]): Promise<FileEntry> {
    const p = normalizePath(path);
    const old = await this.row(p);
    const now = Date.now();
    await this.db.run(
      `INSERT INTO relay_objects (storage_id, path, size, mime, chunks, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (storage_id, path) DO UPDATE SET size = excluded.size, mime = excluded.mime, chunks = excluded.chunks, created_at = excluded.created_at`,
      [this.sid, p, size, mime ?? null, JSON.stringify(chunks), now],
    );
    if (old) await this.deleteRefs((JSON.parse(old.chunks) as RelayChunk[]).map((c) => c.ref));
    return { name: baseName(p), path: p, isDir: false, size, mime: mime ?? undefined, modifiedAt: now };
  }

  async put(path: string, body: ReadableStream<Uint8Array> | Uint8Array, opts: { size: number; mime?: string }): Promise<FileEntry> {
    if (opts.size > MAX_PROXY_BYTES) throw badRequest("檔案太大，請改用分片上傳", "too_large");
    const cs = this.backend.chunkSize;
    const name = baseName(normalizePath(path));
    const chunks: RelayChunk[] = [];
    let buf = new Uint8Array(0);
    let total = 0;
    const flush = async (data: Uint8Array) => {
      const index = chunks.length;
      const ref = await this.backend.uploadChunk(`${name}.part${index}`, data);
      chunks.push({ index, size: data.byteLength, ref });
    };
    try {
      if (body instanceof Uint8Array) {
        total = body.byteLength;
        for (let o = 0; o < body.byteLength; o += cs) await flush(body.subarray(o, o + cs));
      } else {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_PROXY_BYTES) throw badRequest("檔案太大，請改用分片上傳", "too_large");
          const merged = new Uint8Array(buf.byteLength + value.byteLength);
          merged.set(buf);
          merged.set(value, buf.byteLength);
          buf = merged;
          while (buf.byteLength >= cs) {
            await flush(buf.slice(0, cs));
            buf = buf.slice(cs);
          }
        }
        if (buf.byteLength) await flush(buf);
      }
    } catch (e) {
      await this.deleteRefs(chunks.map((c) => c.ref));
      throw e;
    }
    return this.saveObject(path, total, opts.mime, chunks);
  }

  async delete(paths: string[]): Promise<void> {
    for (const raw of paths) {
      const p = normalizePath(raw);
      const rows = await this.db.all<ObjectRow>("SELECT * FROM relay_objects WHERE storage_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')", [
        this.sid,
        p,
        (p === "/" ? "" : likeEscape(p)) + "/%",
      ]);
      for (const r of rows) {
        await this.deleteRefs((JSON.parse(r.chunks) as RelayChunk[]).map((c) => c.ref));
        await this.db.run("DELETE FROM relay_objects WHERE id = ?", [r.id]);
      }
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const f = normalizePath(from);
    const t = normalizePath(to);
    if (f === t) return;
    if (await this.stat(t)) throw new HttpError(409, "conflict", "目標已存在");
    const exact = await this.row(f);
    if (exact) {
      await this.db.run("UPDATE relay_objects SET path = ? WHERE id = ?", [t, exact.id]);
      return;
    }
    const rows = await this.db.all<ObjectRow>("SELECT id, path FROM relay_objects WHERE storage_id = ? AND path LIKE ? ESCAPE '\\'", [this.sid, likeEscape(f) + "/%"]);
    if (!rows.length) throw notFound("找不到檔案");
    await this.db.batch(rows.map((r) => ({ sql: "UPDATE relay_objects SET path = ? WHERE id = ?", params: [t + r.path.slice(f.length), r.id] })));
  }

  // —— 分片中繼上傳 ——

  async initUpload(input: UploadInitInput): Promise<UploadInitResult> {
    void this.sid;
    void this.db;
    const chunkSize = this.backend.chunkSize;
    const chunkCount = Math.max(1, Math.ceil(input.size / chunkSize));
    return {
      protocol: RELAY_PROTOCOL,
      partSize: chunkSize,
      client: { chunkSize, chunkCount, concurrency: this.opts.concurrency ?? 2 },
      meta: { chunkCount },
    };
  }

  private expectedSize(session: UploadSessionView, index: number): number {
    const cs = session.partSize || this.backend.chunkSize;
    const count = Math.max(1, Math.ceil(session.size / cs));
    if (!Number.isInteger(index) || index < 0 || index >= count) throw badRequest(`分片編號超出範圍（0–${count - 1}）`);
    return Math.min(cs, session.size - index * cs);
  }

  async uploadChunk(session: UploadSessionView, index: number, body: Uint8Array): Promise<{ index: number; size: number }> {
    const want = this.expectedSize(session, index);
    if (body.byteLength !== want) throw badRequest(`第 ${index} 片大小應為 ${want} 位元組，收到 ${body.byteLength}`, "chunk_size_mismatch");
    const ref = await this.backend.uploadChunk(`${session.filename}.part${index}`, body);
    const old = await this.db.first<{ ref: string }>("SELECT ref FROM relay_upload_chunks WHERE session_id = ? AND idx = ?", [session.id, index]);
    await this.db.run(
      `INSERT INTO relay_upload_chunks (session_id, storage_id, idx, size, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id, idx) DO UPDATE SET size = excluded.size, ref = excluded.ref, created_at = excluded.created_at`,
      [session.id, this.sid, index, body.byteLength, JSON.stringify(ref), Date.now()],
    );
    if (old) await this.deleteRefs([JSON.parse(old.ref)]);
    return { index, size: body.byteLength };
  }

  async listChunks(session: UploadSessionView): Promise<{ index: number; size: number }[]> {
    const rows = await this.db.all<{ idx: number; size: number }>("SELECT idx, size FROM relay_upload_chunks WHERE session_id = ? ORDER BY idx", [session.id]);
    return rows.map((r) => ({ index: r.idx, size: r.size }));
  }

  async completeUpload(session: UploadSessionView): Promise<{ entry: FileEntry }> {
    const rows = await this.db.all<{ idx: number; size: number; ref: string }>("SELECT idx, size, ref FROM relay_upload_chunks WHERE session_id = ? ORDER BY idx", [session.id]);
    const cs = session.partSize || this.backend.chunkSize;
    const count = Math.max(1, Math.ceil(session.size / cs));
    const have = new Set(rows.map((r) => r.idx));
    const missing = Array.from({ length: count }, (_, i) => i).filter((i) => !have.has(i));
    if (missing.length) throw badRequest(`尚缺 ${missing.length} 個分片（例如第 ${missing.slice(0, 5).join("、")} 片）`, "chunks_missing", { missing });
    const chunks: RelayChunk[] = rows.map((r) => ({ index: r.idx, size: r.size, ref: JSON.parse(r.ref) }));
    const total = chunks.reduce((s, c) => s + c.size, 0);
    if (total !== session.size) throw badRequest(`分片總大小 ${total} 與檔案大小 ${session.size} 不符`);
    const entry = await this.saveObject(session.objectPath, total, session.mime, chunks);
    await this.db.run("DELETE FROM relay_upload_chunks WHERE session_id = ?", [session.id]);
    return { entry };
  }

  async abortUpload(session: UploadSessionView): Promise<void> {
    const rows = await this.db.all<{ ref: string }>("SELECT ref FROM relay_upload_chunks WHERE session_id = ?", [session.id]);
    await this.deleteRefs(rows.map((r) => JSON.parse(r.ref)));
    await this.db.run("DELETE FROM relay_upload_chunks WHERE session_id = ?", [session.id]);
  }
}
