import type {
  DriverDefinition,
  DriverContext,
  FileEntry,
  StorageDriver,
  UploadActionInput,
  UploadActionResult,
  UploadSessionView,
} from "../../types";
import { badRequest, HttpError } from "../../../core/errors";
import { sha256Hex } from "../../../core/crypto";
import { joinPath, contentDisposition, normalizePath } from "../../util";

/**
 * HuggingFace dataset／model 倉庫。
 *
 * 上傳（protocol = "xet"）：瀏覽器跑 @huggingface/hub 的 commit()，
 * hubUrl 指向「本工作階段的 hub 代理」（/api/uploads/:id/action/hub）。代理只放行四種請求：
 *   preupload  → 後端直接回答 uploadMode=lfs（不打 HF）
 *   LFS batch  → 後端帶 HF token 轉送，並移除回應中的 xet 權杖、把 href 改成 xet-token 端點
 *   xet-token  → 後端帶 HF token 呼叫 /xet-write-token/{rev}，回傳短效 xet 寫入權杖
 *   commit     → 後端忽略瀏覽器的 commit 內容，只取 sha256/size 驗證後，自行組 commit 提交
 * xorb／shard 由瀏覽器直接 POST 到 cas-server（使用短效權杖），位元組不經過後端。
 * 瀏覽器看到的倉庫名稱是假名（UPLOAD_REPO），真實 repo 與 token 都不會外洩。
 */

export const UPLOAD_REPO = "harbordrop/upload";

interface HfConfig {
  repoType: "dataset" | "model";
  repo: string;
  revision: string;
  pathPrefix: string;
  token?: string;
  downloadMode: "auto" | "redirect" | "proxy";
  hubUrl: string;
}

function parseConfig(c: Record<string, any>): HfConfig {
  if (!c.repo || !/^[\w.-]+\/[\w.-]+$/.test(c.repo)) throw badRequest("倉庫格式應為 使用者/名稱");
  return {
    repoType: c.repoType === "model" ? "model" : "dataset",
    repo: c.repo,
    revision: c.revision || "main",
    pathPrefix: normalizePath(c.pathPrefix || "/"),
    token: c.token || undefined,
    downloadMode: ["redirect", "proxy"].includes(c.downloadMode) ? c.downloadMode : "auto",
    hubUrl: (c.hubUrl || "https://huggingface.co").replace(/\/+$/, ""),
  };
}

class HuggingFaceDriver implements StorageDriver {
  readonly type = "huggingface";
  readonly capabilities = {
    list: true,
    write: true,
    delete: true,
    mkdir: false,
    rename: false,
    copy: false,
    uploadProtocols: ["xet"],
  };
  private isPrivate: boolean | undefined;

  constructor(
    private cfg: HfConfig,
    private ctx: DriverContext,
  ) {}

  private get apiRepo() {
    return `${this.cfg.hubUrl}/api/${this.cfg.repoType}s/${this.cfg.repo}`;
  }
  private get gitRepo() {
    return `${this.cfg.hubUrl}/${this.cfg.repoType === "model" ? "" : this.cfg.repoType + "s/"}${this.cfg.repo}`;
  }
  /** 儲存相對路徑 → 倉庫內路徑（無開頭 /） */
  repoPath(path: string): string {
    return joinPath(this.cfg.pathPrefix, path).replace(/^\/+/, "");
  }
  private auth(h: Record<string, string> = {}): Record<string, string> {
    return this.cfg.token ? { ...h, Authorization: `Bearer ${this.cfg.token}` } : h;
  }
  private async hf(url: string, init: RequestInit = {}): Promise<Response> {
    return this.ctx.fetch(url, { ...init, headers: this.auth((init.headers as Record<string, string>) ?? {}) });
  }
  private async hfJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const r = await this.hf(url, init);
    if (!r.ok) throw new HttpError(502, "upstream_error", `HuggingFace 回應 ${r.status}：${(await r.text()).slice(0, 300)}`);
    return r.json() as Promise<T>;
  }

  async testConnection() {
    try {
      const info = await this.hfJson<{ private?: boolean; id: string }>(`${this.apiRepo}/revision/${encodeURIComponent(this.cfg.revision)}`);
      this.isPrivate = !!info.private;
      return { ok: true, message: `已連線：${info.id}（${info.private ? "私有" : "公開"}）` };
    } catch (e: any) {
      return { ok: false, message: e.message };
    }
  }

  private async repoIsPrivate(): Promise<boolean> {
    if (this.isPrivate === undefined) {
      const info = await this.hfJson<{ private?: boolean }>(this.apiRepo);
      this.isPrivate = !!info.private;
    }
    return this.isPrivate;
  }

  async stat(path: string): Promise<FileEntry | null> {
    const body = new URLSearchParams({ paths: this.repoPath(path), expand: "true" });
    const arr = await this.hfJson<any[]>(`${this.apiRepo}/paths-info/${encodeURIComponent(this.cfg.revision)}`, {
      method: "POST",
      body,
    });
    const it = arr[0];
    if (!it) return null;
    return this.toEntry(it, path);
  }

  private toEntry(it: any, path: string): FileEntry {
    return {
      name: it.path.split("/").pop(),
      path,
      isDir: it.type === "directory",
      size: it.lfs?.size ?? it.size,
      sha256: it.lfs?.oid,
      etag: it.oid,
      modifiedAt: it.lastCommit?.date ? Date.parse(it.lastCommit.date) : undefined,
    };
  }

  async list(path: string, opts: { cursor?: string } = {}) {
    const rp = this.repoPath(path);
    const url = opts.cursor || `${this.apiRepo}/tree/${encodeURIComponent(this.cfg.revision)}/${rp.split("/").map(encodeURIComponent).join("/")}`;
    const r = await this.hf(url);
    if (r.status === 404) return { entries: [] };
    if (!r.ok) throw new HttpError(502, "upstream_error", `HuggingFace 回應 ${r.status}`);
    const arr = (await r.json()) as any[];
    const next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get("link") ?? "")?.[1];
    const base = normalizePath(path);
    return {
      entries: arr.map((it) => this.toEntry(it, joinPath(base, it.path.split("/").pop()))),
      cursor: next,
    };
  }

  resolveUrl(path: string, download: boolean): string {
    const p = this.repoPath(path).split("/").map(encodeURIComponent).join("/");
    return `${this.gitRepo}/resolve/${encodeURIComponent(this.cfg.revision)}/${p}${download ? "?download=true" : ""}`;
  }

  async download(path: string, opts: { filename?: string; inline?: boolean; mime?: string; request?: Request } = {}) {
    const proxy = this.cfg.downloadMode === "proxy" || (this.cfg.downloadMode === "auto" && (await this.repoIsPrivate()));
    if (!proxy) return { kind: "redirect" as const, url: this.resolveUrl(path, !opts.inline) };
    // 私有倉庫：帶 token 代理串流（支援 Range）
    const headers: Record<string, string> = {};
    const range = opts.request?.headers.get("range");
    if (range) headers.Range = range;
    const up = await this.hf(this.resolveUrl(path, false), { headers, redirect: "follow" });
    if (!up.ok && up.status !== 206) throw new HttpError(up.status === 404 ? 404 : 502, "upstream_error", `HuggingFace 下載失敗（${up.status}）`);
    const h = new Headers();
    for (const k of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const v = up.headers.get(k);
      if (v) h.set(k, v);
    }
    h.set("content-type", opts.mime || up.headers.get("content-type") || "application/octet-stream");
    h.set("content-disposition", contentDisposition(opts.filename ?? path.split("/").pop()!, !!opts.inline));
    return { kind: "response" as const, response: new Response(up.body, { status: up.status, headers: h }) };
  }

  async delete(paths: string[]) {
    await this.commit(
      `HarborDrop 刪除 ${paths.length} 個檔案`,
      paths.map((p) => ({ key: "deletedFile", value: { path: this.repoPath(p) } })),
    );
  }

  async commit(summary: string, ops: { key: string; value: unknown }[]): Promise<{ commitOid: string; commitUrl: string }> {
    const body = [{ key: "header", value: { summary } }, ...ops].map((x) => JSON.stringify(x)).join("\n");
    return this.hfJson(`${this.apiRepo}/commit/${encodeURIComponent(this.cfg.revision)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-ndjson" },
      body,
    });
  }

  // ───────── 上傳（Xet） ─────────

  async initUpload(input: { path: string; filename: string; size: number }) {
    const clientPath = sanitizeClientPath(input.filename);
    return {
      protocol: "xet",
      client: {
        repoType: "dataset",
        repo: UPLOAD_REPO,
        revision: "main",
        path: clientPath,
        // 續傳命名空間：同一真實倉庫的 xorb 可跨工作階段略過（以雜湊隱藏倉庫名稱）
        resumeScope: "xet:" + (await sha256Hex(`${this.cfg.hubUrl}|${this.cfg.repoType}|${this.cfg.repo}`)).slice(0, 16),
      },
      meta: { clientPath, repoPath: this.repoPath(input.path) },
    };
  }

  async uploadAction(session: UploadSessionView, action: string, input: UploadActionInput): Promise<UploadActionResult> {
    if (action === "xet-token") return this.mintXetToken();
    if (action !== "hub") throw badRequest("不支援的動作");
    const sub = input.subpath.replace(/^\/+/, "");
    const req = input.request;
    const fake = `datasets/${UPLOAD_REPO}`;
    if (req.method === "POST" && sub === `api/${fake}/preupload/main`) {
      const body = (await req.json()) as { files: { path: string }[] };
      const files = batchFiles(session);
      return {
        response: Response.json({
          files: body.files.map((f) => {
            if (files) {
              if (!files.some((x) => x.clientPath === f.path)) throw badRequest("上傳路徑不符");
            } else if (f.path !== session.meta.clientPath) {
              throw badRequest("上傳路徑不符");
            }
            return { path: f.path, uploadMode: "lfs", shouldIgnore: false };
          }),
        }),
      };
    }
    if (req.method === "POST" && sub === `${fake}.git/info/lfs/objects/batch`) {
      return this.proxyLfsBatch(session, req, input.actionBase);
    }
    if (req.method === "POST" && sub === `api/${fake}/commit/main`) {
      return this.commitUpload(session, await req.text());
    }
    throw badRequest(`代理不允許此請求：${req.method} ${sub}`);
  }

  private async mintXetToken(): Promise<UploadActionResult> {
    const r = await this.hf(`${this.apiRepo}/xet-write-token/${encodeURIComponent(this.cfg.revision)}`);
    if (!r.ok) throw new HttpError(502, "upstream_error", `取得 xet 寫入權杖失敗（${r.status}）：${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { accessToken: string; casUrl: string; exp: number };
    return { response: Response.json({ accessToken: j.accessToken, casUrl: j.casUrl, exp: j.exp }) };
  }

  private async proxyLfsBatch(session: UploadSessionView, req: Request, actionBase: string): Promise<UploadActionResult> {
    const body = (await req.json()) as { objects: { oid: string; size: number }[]; transfers?: string[] };
    const files = batchFiles(session);
    if (!files) {
      if (body.objects?.length !== 1) throw badRequest("一次只能上傳一個檔案");
      const obj = body.objects[0];
      if (obj.size !== session.size) throw badRequest("檔案大小與上傳工作階段不符");
      if (!/^[0-9a-f]{64}$/.test(obj.oid)) throw badRequest("sha256 格式錯誤");
      return this.doLfsBatch([obj], body.transfers, actionBase, { sha256: obj.oid });
    }
    // 批次：一次送多個物件（hub 的 commitIter 會把整批檔案放在同一個 batch 請求裡）；
    // 每個物件的大小必須對上批次裡某個檔案，oid 之後在 commit 時逐檔核對。
    if (!body.objects?.length) throw badRequest("LFS batch 缺少檔案");
    const sizes = new Set(files.map((f) => f.size));
    for (const o of body.objects) {
      if (!sizes.has(o.size)) throw badRequest("檔案大小與上傳工作階段不符");
      if (!/^[0-9a-f]{64}$/.test(o.oid)) throw badRequest("sha256 格式錯誤");
    }
    // 內容相同的檔案 oid 會重複，只送一份給 HF
    const seen = new Map<string, { oid: string; size: number }>();
    for (const o of body.objects) seen.set(`${o.oid}:${o.size}`, o);
    const pairs = [...seen.values()];
    const prev = (session.meta.batches as { oid: string; size: number }[] | undefined) ?? [];
    const merged = [...prev];
    for (const p of pairs) if (!merged.some((m) => m.oid === p.oid && m.size === p.size)) merged.push(p);
    return this.doLfsBatch(pairs, body.transfers, actionBase, { batches: merged });
  }

  /** 轉送 LFS batch 給 HF，並把回應裡絕不可外洩的權杖清掉。meta 會併入工作階段。 */
  private async doLfsBatch(
    objects: { oid: string; size: number }[],
    transfers: string[] | undefined,
    actionBase: string,
    meta: Record<string, unknown>,
  ): Promise<UploadActionResult> {
    const r = await this.hf(`${this.gitRepo}.git/info/lfs/objects/batch`, {
      method: "POST",
      headers: { Accept: "application/vnd.git-lfs+json", "Content-Type": "application/vnd.git-lfs+json" },
      body: JSON.stringify({
        operation: "upload",
        transfers: transfers ?? ["basic", "multipart", "xet"],
        hash_algo: "sha_256",
        ref: { name: this.cfg.revision },
        objects,
      }),
    });
    const text = await r.text();
    if (!r.ok) throw new HttpError(502, "upstream_error", `LFS batch 失敗（${r.status}）：${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    for (const o of json.objects ?? []) {
      // 安全：HF 的 verify 動作標頭內含「HF token 明文」（Authorization: Bearer hf_…），絕不可回傳瀏覽器
      if (o.actions) delete o.actions.verify;
      for (const a of Object.values<any>(o.actions ?? {}))
        for (const k of Object.keys(a?.header ?? {})) if (/^authorization$/i.test(k)) delete a.header[k];
      const up = o.actions?.upload;
      if (up && json.transfer === "xet") {
        // 不把 HF 回的權杖給瀏覽器；改由 xet-token 端點（經後端）換發
        const h = { ...(up.header ?? {}) };
        for (const k of Object.keys(h)) if (/^x-xet-(access-token|token-expiration)$/i.test(k)) delete h[k];
        up.header = h;
        up.href = `${actionBase}/xet-token`;
      }
    }
    return {
      response: new Response(JSON.stringify(json), { headers: { "Content-Type": "application/vnd.git-lfs+json" } }),
      meta: { ...meta, transfer: json.transfer },
      state: "uploading",
    };
  }

  private async commitUpload(session: UploadSessionView, ndjson: string): Promise<UploadActionResult> {
    const ops = ndjson
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const lfsEntries = ops.filter((o) => o.key === "lfsFile").map((o) => o.value);
    const files = batchFiles(session);
    if (!files) {
      const lfs = lfsEntries[0];
      if (!lfs || lfs.path !== session.meta.clientPath) throw badRequest("commit 內容不符");
      if (lfs.oid !== session.meta.sha256 || lfs.size !== session.size) throw badRequest("sha256 或大小與 LFS batch 不符");
      const res = await this.commit(`HarborDrop 上傳 ${session.filename}`, [
        { key: "lfsFile", value: { path: session.meta.repoPath, algo: "sha256", size: session.size, oid: lfs.oid } },
      ]);
      return { response: Response.json(res), meta: { commitOid: res.commitOid }, state: "committed" };
    }
    // 批次：整批檔案一次提交。逐檔核對路徑、大小與 LFS batch 登記過的 oid，
    // 全部通過才送出一個 HF commit；任一檔不符就整批拒絕、不提交。
    if (lfsEntries.length !== files.length) throw badRequest("commit 檔案數量與批次不符");
    const batches = (session.meta.batches as { oid: string; size: number }[] | undefined) ?? [];
    const byPath = new Map(files.map((f) => [f.clientPath, f]));
    const seenPaths = new Set<string>();
    const updated = files.map((f) => ({ ...f }));
    const commitOps: { key: string; value: unknown }[] = [];
    for (const lfs of lfsEntries) {
      const f = byPath.get(lfs.path);
      if (!f || seenPaths.has(lfs.path)) throw badRequest("commit 內容不符");
      seenPaths.add(lfs.path);
      if (lfs.size !== f.size) throw badRequest("sha256 或大小與 LFS batch 不符");
      if (!batches.some((b) => b.oid === lfs.oid && b.size === lfs.size)) throw badRequest("sha256 或大小與 LFS batch 不符");
      updated.find((x) => x.clientPath === f.clientPath)!.sha256 = lfs.oid;
      commitOps.push({ key: "lfsFile", value: { path: f.repoPath, algo: "sha256", size: f.size, oid: lfs.oid } });
    }
    const res = await this.commit(`HarborDrop 批次上傳 ${files.length} 個檔案`, commitOps);
    return { response: Response.json(res), meta: { files: updated, commitOid: res.commitOid }, state: "committed" };
  }

  async completeUpload(session: UploadSessionView) {
    if (!session.meta.commitOid) throw badRequest("檔案尚未提交到 HuggingFace", "not_committed");
    const entry = await this.stat(session.objectPath);
    if (!entry) throw new HttpError(502, "upstream_error", "提交後在倉庫中找不到檔案");
    if (entry.size !== session.size || entry.sha256 !== session.meta.sha256)
      throw new HttpError(502, "verify_failed", `倉庫中檔案大小或 sha256 不符（${entry.size} / ${entry.sha256}）`);
    return { entry };
  }

  /** 批次完成：逐檔在倉庫中驗證大小與 sha256（8 個並行，避免幾百檔時等太久）。 */
  async completeBatchUpload(session: UploadSessionView) {
    const files = batchFiles(session);
    if (!files) throw badRequest("此工作階段不是批次上傳");
    if (!session.meta.commitOid) throw badRequest("檔案尚未提交到 HuggingFace", "not_committed");
    const entries: FileEntry[] = [];
    for (let i = 0; i < files.length; i += 8) {
      const chunk = files.slice(i, i + 8);
      const got = await Promise.all(chunk.map((f) => this.stat(f.rel)));
      for (let j = 0; j < chunk.length; j++) {
        const f = chunk[j];
        const entry = got[j];
        if (!entry) throw new HttpError(502, "upstream_error", `提交後在倉庫中找不到檔案：${f.filename}`);
        if (entry.size !== f.size || entry.sha256 !== f.sha256)
          throw new HttpError(502, "verify_failed", `倉庫中檔案大小或 sha256 不符：${f.filename}`);
        entries.push(entry);
      }
    }
    return { entries };
  }

  async abortUpload() {
    // 未提交的 xorb 由 HF 自行回收，無需處理
  }
}

/** 批次上傳工作階段裡的一個檔案（存在 session.meta.files；sha256 在 commit 時填入）。 */
export interface BatchFileMeta {
  clientPath: string; // 瀏覽器端路徑（hub 操作用，檔名經 sanitize）
  repoPath: string; // 倉庫內路徑（commit 用）
  rel: string; // 儲存內路徑（stat 驗證用）
  filename: string;
  vpath: string; // 前端顯示路徑
  size: number;
  sha256?: string;
}

/** 取出批次工作階段的檔案清單；單檔工作階段回 null。 */
export function batchFiles(session: UploadSessionView): BatchFileMeta[] | null {
  const files = session.meta?.files as BatchFileMeta[] | undefined;
  return Array.isArray(files) && files.length ? files : null;
}

/** 瀏覽器端使用的檔名：只留安全字元，避免 hub 代理路徑比對出錯 */
function sanitizeClientPath(name: string): string {
  const s = name.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(-120);
  return s || "file";
}

export const huggingfaceDriver: DriverDefinition = {
  type: "huggingface",
  label: "HuggingFace 倉庫",
  description: "Dataset／Model 倉庫，大檔以 Xet 協定由瀏覽器直傳",
  fields: [
    {
      key: "repoType",
      label: "倉庫類型",
      type: "select",
      default: "dataset",
      options: [
        { value: "dataset", label: "Dataset" },
        { value: "model", label: "Model" },
      ],
    },
    { key: "repo", label: "倉庫", type: "string", required: true, placeholder: "使用者/名稱" },
    { key: "revision", label: "分支", type: "string", default: "main" },
    { key: "pathPrefix", label: "路徑前綴", type: "string", default: "/", help: "所有檔案存放在此資料夾下" },
    { key: "token", label: "存取權杖（HF Token）", type: "secret", required: true, help: "需要 write 權限；只存在伺服器端" },
    {
      key: "downloadMode",
      label: "下載方式",
      type: "select",
      default: "auto",
      options: [
        { value: "auto", label: "自動（私有倉庫代理，公開倉庫轉址）" },
        { value: "redirect", label: "轉址到 resolve URL" },
        { value: "proxy", label: "經後端代理串流" },
      ],
    },
  ],
  create: (config, ctx) => new HuggingFaceDriver(parseConfig(config), ctx),
};
