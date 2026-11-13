import { AwsClient } from "aws4fetch";
import type { DriverContext, DriverDefinition, FileEntry, StorageDriver, UploadActionInput, UploadActionResult, UploadSessionView } from "../../types";
import { badRequest, HttpError } from "../../../core/errors";
import { contentDisposition, joinPath, normalizePath } from "../../util";

/**
 * S3 相容儲存（AWS S3、R2、B2、MinIO…）。
 * 上傳（protocol = "s3-multipart"）：後端 CreateMultipartUpload → 瀏覽器以預簽章 URL 直接 PUT 各分片
 * → 後端 CompleteMultipartUpload。位元組不經過後端。
 * 需在 bucket 設定 CORS：允許前端網域 PUT/GET，並 ExposeHeaders: ETag。
 */

const MiB = 1024 * 1024;
const MIN_PART = 5 * MiB;
const MAX_PARTS = 10000;
const PRESIGN_SECONDS = 3600;

interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  pathPrefix: string;
  partSizeMB: number;
  concurrency: number;
}

function parseConfig(c: Record<string, any>): S3Config {
  if (!c.endpoint || !c.bucket) throw badRequest("S3 需要 endpoint 與 bucket");
  return {
    endpoint: String(c.endpoint).replace(/\/+$/, ""),
    region: c.region || "auto",
    bucket: c.bucket,
    accessKeyId: c.accessKeyId ?? "",
    secretAccessKey: c.secretAccessKey ?? "",
    forcePathStyle: c.forcePathStyle === true || c.forcePathStyle === "true",
    pathPrefix: normalizePath(c.pathPrefix || "/"),
    partSizeMB: Math.max(5, Number(c.partSizeMB) || 16),
    concurrency: Math.min(16, Math.max(1, Number(c.concurrency) || 4)),
  };
}

const xmlTag = (xml: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];
const xmlAll = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
const xmlUnescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 依檔案大小決定分片大小：至少設定值，且分片數不超過 10000 */
export function choosePartSize(size: number, preferred: number): number {
  let part = Math.max(MIN_PART, preferred);
  while (Math.ceil(size / part) > MAX_PARTS) part *= 2;
  return part;
}

export class S3Driver implements StorageDriver {
  readonly type = "s3";
  readonly capabilities = {
    list: true,
    write: true,
    delete: true,
    mkdir: false,
    rename: false,
    copy: false,
    uploadProtocols: ["s3-multipart"],
    maxProxyUploadBytes: 95 * MiB,
  };
  private aws: AwsClient;

  constructor(
    private cfg: S3Config,
    private ctx: DriverContext,
  ) {
    this.aws = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: "s3", region: cfg.region });
  }

  key(path: string): string {
    return joinPath(this.cfg.pathPrefix, path).replace(/^\/+/, "");
  }

  private url(key: string, query: Record<string, string> = {}): string {
    const encKey = key.split("/").map(encodeURIComponent).join("/");
    const u = new URL(this.cfg.endpoint);
    let base: string;
    if (this.cfg.forcePathStyle) base = `${u.origin}${u.pathname.replace(/\/$/, "")}/${this.cfg.bucket}/${encKey}`;
    else base = `${u.protocol}//${this.cfg.bucket}.${u.host}${u.pathname.replace(/\/$/, "")}/${encKey}`;
    const qs = new URLSearchParams(query).toString();
    return qs ? `${base}?${qs}` : base;
  }

  private async s3(url: string, init: RequestInit = {}): Promise<Response> {
    return this.aws.fetch(url, init);
  }

  private async ensureOk(r: Response, what: string) {
    if (!r.ok) {
      const t = await r.text();
      throw new HttpError(502, "upstream_error", `S3 ${what} 失敗（${r.status}）：${xmlTag(t, "Message") ?? t.slice(0, 200)}`);
    }
  }

  async presign(url: string, method: string, expires = PRESIGN_SECONDS): Promise<string> {
    const u = new URL(url);
    u.searchParams.set("X-Amz-Expires", String(expires));
    const signed = await this.aws.sign(u.toString(), { method, aws: { signQuery: true } });
    return signed.url;
  }

  async testConnection() {
    try {
      const r = await this.s3(this.url("", { "list-type": "2", "max-keys": "1" }).replace(/\/\?/, "/?"));
      await this.ensureOk(r, "列出物件");
      return { ok: true, message: `已連線：bucket ${this.cfg.bucket}` };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }

  async stat(path: string): Promise<FileEntry | null> {
    const r = await this.s3(this.url(this.key(path)), { method: "HEAD" });
    if (r.status === 404) return null;
    await this.ensureOk(r, "HEAD");
    return {
      name: path.split("/").pop()!,
      path,
      isDir: false,
      size: Number(r.headers.get("content-length") ?? 0),
      mime: r.headers.get("content-type") ?? undefined,
      etag: r.headers.get("etag")?.replace(/"/g, ""),
      modifiedAt: r.headers.get("last-modified") ? Date.parse(r.headers.get("last-modified")!) : undefined,
    };
  }

  async list(path: string, opts: { cursor?: string; limit?: number } = {}) {
    const prefix = this.key(path);
    const q: Record<string, string> = { "list-type": "2", delimiter: "/", prefix: prefix ? prefix + "/" : "" };
    if (opts.cursor) q["continuation-token"] = opts.cursor;
    if (opts.limit) q["max-keys"] = String(opts.limit);
    const r = await this.s3(this.url("", q));
    await this.ensureOk(r, "列出物件");
    const xml = await r.text();
    const base = normalizePath(path);
    const dirs: FileEntry[] = xmlAll(xml, "CommonPrefixes").map((cp) => {
      const name = xmlUnescape(xmlTag(cp, "Prefix")!).replace(/\/$/, "").split("/").pop()!;
      return { name, path: joinPath(base, name), isDir: true };
    });
    const files: FileEntry[] = xmlAll(xml, "Contents")
      .map((c) => {
        const key = xmlUnescape(xmlTag(c, "Key")!);
        const name = key.split("/").pop()!;
        return {
          name,
          path: joinPath(base, name),
          isDir: false,
          size: Number(xmlTag(c, "Size") ?? 0),
          etag: xmlTag(c, "ETag")?.replace(/&quot;|"/g, ""),
          modifiedAt: Date.parse(xmlTag(c, "LastModified") ?? ""),
        };
      })
      .filter((f) => f.name);
    const next = xmlTag(xml, "NextContinuationToken");
    return { entries: [...dirs, ...files], cursor: next ? xmlUnescape(next) : undefined };
  }

  async download(path: string, opts: { filename?: string; inline?: boolean; mime?: string } = {}) {
    const q: Record<string, string> = {
      "response-content-disposition": contentDisposition(opts.filename ?? path.split("/").pop()!, !!opts.inline),
    };
    if (opts.mime) q["response-content-type"] = opts.mime;
    const url = await this.presign(this.url(this.key(path), q), "GET");
    return { kind: "redirect" as const, url, expiresAt: Date.now() + PRESIGN_SECONDS * 1000 };
  }

  async put(path: string, body: ReadableStream<Uint8Array> | Uint8Array, opts: { size: number; mime?: string }) {
    const r = await this.s3(this.url(this.key(path)), {
      method: "PUT",
      body: body as BodyInit,
      headers: { "content-type": opts.mime || "application/octet-stream", "content-length": String(opts.size) },
      // @ts-expect-error Node 串流上傳需要 duplex
      duplex: "half",
    });
    await this.ensureOk(r, "PUT");
    return (await this.stat(path))!;
  }

  async delete(paths: string[]) {
    for (const p of paths) {
      const r = await this.s3(this.url(this.key(p)), { method: "DELETE" });
      if (r.status !== 404) await this.ensureOk(r, "DELETE");
    }
  }

  // ───────── multipart 直傳 ─────────

  async initUpload(input: { path: string; size: number; mime?: string; partSize?: number }) {
    const partSize = choosePartSize(input.size, input.partSize ?? this.cfg.partSizeMB * MiB);
    const r = await this.s3(this.url(this.key(input.path), { uploads: "" }).replace("uploads=", "uploads"), {
      method: "POST",
      headers: { "content-type": input.mime || "application/octet-stream" },
    });
    await this.ensureOk(r, "CreateMultipartUpload");
    const uploadId = xmlTag(await r.text(), "UploadId");
    if (!uploadId) throw new HttpError(502, "upstream_error", "S3 未回傳 UploadId");
    return {
      protocol: "s3-multipart",
      providerUploadId: xmlUnescape(uploadId),
      partSize,
      client: { partSize, partCount: Math.max(1, Math.ceil(input.size / partSize)), concurrency: this.cfg.concurrency },
    };
  }

  async uploadAction(session: UploadSessionView, action: string, input: UploadActionInput): Promise<UploadActionResult> {
    const key = this.key(session.objectPath);
    const uploadId = session.providerUploadId!;
    if (action === "sign-parts") {
      const { partNumbers } = (await input.request.json()) as { partNumbers: number[] };
      const max = Math.max(1, Math.ceil(session.size / (session.partSize ?? 1)));
      if (!Array.isArray(partNumbers) || partNumbers.length > 100) throw badRequest("partNumbers 無效");
      const urls: Record<number, string> = {};
      for (const n of partNumbers) {
        if (!Number.isInteger(n) || n < 1 || n > max) throw badRequest(`分片編號 ${n} 超出範圍`);
        urls[n] = await this.presign(this.url(key, { partNumber: String(n), uploadId }), "PUT");
      }
      return { response: Response.json({ urls, expiresIn: PRESIGN_SECONDS }), state: "uploading" };
    }
    if (action === "list-parts") {
      // 續傳：回傳 S3 已收到的分片
      const parts: { partNumber: number; etag: string; size: number }[] = [];
      let marker: string | undefined;
      do {
        const q: Record<string, string> = { uploadId };
        if (marker) q["part-number-marker"] = marker;
        const r = await this.s3(this.url(key, q));
        await this.ensureOk(r, "ListParts");
        const xml = await r.text();
        for (const p of xmlAll(xml, "Part"))
          parts.push({ partNumber: Number(xmlTag(p, "PartNumber")), etag: xmlTag(p, "ETag")!.replace(/&quot;/g, '"'), size: Number(xmlTag(p, "Size")) });
        marker = xmlTag(xml, "IsTruncated") === "true" ? xmlTag(xml, "NextPartNumberMarker") : undefined;
      } while (marker);
      return { response: Response.json({ parts }) };
    }
    throw badRequest("不支援的動作");
  }

  async completeUpload(session: UploadSessionView, body: { parts: { partNumber: number; etag: string }[] }) {
    const parts = [...(body?.parts ?? [])].sort((a, b) => a.partNumber - b.partNumber);
    const expected = Math.max(1, Math.ceil(session.size / (session.partSize ?? 1)));
    if (parts.length !== expected) throw badRequest(`分片數不符：收到 ${parts.length}，應為 ${expected}`);
    const xml =
      "<CompleteMultipartUpload>" +
      parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join("") +
      "</CompleteMultipartUpload>";
    const r = await this.s3(this.url(this.key(session.objectPath), { uploadId: session.providerUploadId! }), {
      method: "POST",
      body: xml,
      headers: { "content-type": "application/xml" },
    });
    const text = await r.text();
    if (!r.ok || /<Error>/.test(text)) throw new HttpError(502, "upstream_error", `CompleteMultipartUpload 失敗：${xmlTag(text, "Message") ?? r.status}`);
    const entry = await this.stat(session.objectPath);
    if (!entry || entry.size !== session.size) throw new HttpError(502, "verify_failed", "完成後的物件大小不符");
    return { entry };
  }

  async abortUpload(session: UploadSessionView) {
    if (!session.providerUploadId) return;
    await this.s3(this.url(this.key(session.objectPath), { uploadId: session.providerUploadId }), { method: "DELETE" });
  }
}

export const s3Driver: DriverDefinition = {
  type: "s3",
  label: "S3 相容儲存",
  description: "AWS S3、Cloudflare R2、Backblaze B2、MinIO 等；分片預簽章直傳",
  fields: [
    { key: "endpoint", label: "Endpoint", type: "string", required: true, placeholder: "https://s3.us-east-1.amazonaws.com" },
    { key: "region", label: "區域", type: "string", default: "auto" },
    { key: "bucket", label: "Bucket", type: "string", required: true },
    { key: "accessKeyId", label: "Access Key ID", type: "secret", required: true },
    { key: "secretAccessKey", label: "Secret Access Key", type: "secret", required: true },
    { key: "forcePathStyle", label: "使用路徑式 URL（path-style）", type: "boolean", default: false, help: "MinIO 等自架服務通常需開啟" },
    { key: "pathPrefix", label: "路徑前綴", type: "string", default: "/" },
    { key: "partSizeMB", label: "分片大小（MB）", type: "number", default: 16 },
    { key: "concurrency", label: "同時上傳分片數", type: "number", default: 4 },
  ],
  create: (config, ctx) => new S3Driver(parseConfig(config), ctx),
};
