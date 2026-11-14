import type { HdModule } from "../types";
import type { AppContext, HdContext } from "../../core/context";
import { can, type Principal } from "../../core/auth";
import { randomId, verifyPassword } from "../../core/crypto";
import { HttpError, badRequest, conflict, forbidden, notFound, unauthorized } from "../../core/errors";
import { guessMime } from "../../storage/util";
import type { FileEntry, StorageDriver } from "../../storage/types";
import { API_KEY_RE, verifyApiKey } from "../apikeys/service";
import { assertNotLocked, attemptKey, clearFailures, clientIp, recordFailure, tooMany } from "../auth/ratelimit";
import { effectiveMeta, isHidden } from "../fsmeta/service";
import { createTask } from "../tasks/service";
import { basename, dirname, loadMounts, resolveIn, virtualChildren, type MountRow, type Resolved } from "../fs/mounts";
import { newTransferPayload, TRANSFER_KIND } from "../fs/transfer";
import {
  DAV_PREFIX,
  davPathToVpath,
  destinationToVpath,
  extractOwner,
  hrefFor,
  lockResponse,
  multistatus,
  parseRange,
  propResponse,
  proppatchResponse,
  sliceStream,
  type DavProps,
} from "./xml";

/**
 * WebDAV 伺服器（規格：docs/MODULES-zhTW.md#webdav）
 *   路由：/dav/*；虛擬路徑同 fs 模組（modules/fs/mounts.ts 掛載解析）。
 *   驗證：Basic Auth — 管理員帳密，或「任意使用者名稱 + API 金鑰作密碼」；亦接受 Bearer / X-API-Key。
 *         需要 `webdav` 權限；寫入另需 `fs.write`、刪除（含 MOVE 來源）另需 `fs.delete`（皆以 can() 依路徑檢查）。
 *   方法：OPTIONS、PROPFIND（Depth 0/1）、PROPPATCH（假回應）、GET/HEAD（Range）、PUT、DELETE、MKCOL、MOVE、COPY、
 *         LOCK/UNLOCK（假鎖，讓 Windows／macOS Finder 能以讀寫模式掛載）。
 */

const ALLOW = "OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK";
const METHODS = ALLOW.split(", ");
const REALM = 'Basic realm="HarborDrop WebDAV", charset="UTF-8"';
/** Workers 免費方案請求體上限 100MB */
const WORKERS_BODY_LIMIT = 100 * 1024 * 1024;
const LIST_MAX = 10_000;

type Perm = "webdav" | "fs.write" | "fs.delete";

interface Node {
  vpath: string;
  r: Resolved | null;
  driver: StorageDriver | null;
  /** null = 不存在 */
  entry: DavProps | null;
  /** 掛載於此路徑之下的虛擬子目錄名稱 */
  virtual: string[];
}

// ───────── 驗證 ─────────
function parseBasic(h: string | undefined): { user: string; pass: string } | null {
  if (!h || !/^Basic\s+/i.test(h)) return null;
  try {
    const bin = atob(h.replace(/^Basic\s+/i, "").trim());
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const s = new TextDecoder().decode(bytes);
    const i = s.indexOf(":");
    if (i < 0) return null;
    return { user: s.slice(0, i), pass: s.slice(i + 1) };
  } catch {
    return null;
  }
}

async function davPrincipal(c: HdContext): Promise<Principal> {
  const ctx = c.get("ctx");
  const basic = parseBasic(c.req.header("authorization"));
  if (basic) {
    if (API_KEY_RE.test(basic.pass)) {
      const p = await verifyApiKey(ctx, basic.pass);
      if (!p) throw unauthorized("API 金鑰無效、已停用或已過期", "invalid_api_key");
      return p;
    }
    const key = attemptKey(clientIp(c), "dav:" + basic.user);
    await assertNotLocked(ctx, key);
    const admin = await ctx.db.first<{ id: number; username: string; password_hash: string; totp_enabled: number }>(
      "SELECT id, username, password_hash, totp_enabled FROM admins WHERE username = ?",
      [basic.user],
    );
    const ok = admin ? await verifyPassword(basic.pass, admin.password_hash) : false;
    if (!admin || !ok) {
      const r = await recordFailure(ctx, key);
      if (r.locked && r.lockedUntil) throw tooMany(r.lockedUntil);
      throw unauthorized("帳號或密碼錯誤", "invalid_credentials");
    }
    await clearFailures(ctx, key);
    if (admin.totp_enabled) throw unauthorized("此管理員已啟用兩步驟驗證，WebDAV 請改用 API 金鑰作為密碼", "totp_requires_apikey");
    return { kind: "admin", id: admin.id, username: admin.username };
  }
  return c.get("principal") ?? { kind: "anon" };
}

/** 虛擬路徑底下是否有任一掛載點可讀 */
function virtualVisible(p: Principal, mounts: MountRow[], vpath: string): boolean {
  return mounts.some(
    (m) => (vpath === "/" || m.mount_path.startsWith(vpath + "/")) && can(p, "webdav", { storageId: m.storage_id, mountId: m.id, path: m.mount_path }),
  );
}

function check(p: Principal, perm: Perm, vpath: string, r: Resolved | null, mounts: MountRow[] = []) {
  // 虛擬目錄（無對應掛載）的讀取：只要底下有可讀的掛載點即可列出（子項目會再逐一過濾）
  if (!r && perm === "webdav" && can(p, "webdav") && virtualVisible(p, mounts, vpath)) return;
  const scope = { storageId: r?.storageId, mountId: r?.mount.id, path: vpath };
  if (!can(p, "webdav", scope)) throw forbidden("沒有 WebDAV 權限");
  if (perm !== "webdav" && !can(p, perm, scope)) throw forbidden(perm === "fs.delete" ? "沒有刪除權限" : "沒有寫入權限");
  if (perm !== "webdav" && r?.mount.readonly) throw forbidden("此掛載為唯讀", "readonly");
}

/** 隱藏與密碼：非管理員看不到被隱藏的項目；需密碼的目錄 WebDAV 無法解鎖，直接拒絕 */
async function guard(ctx: AppContext, p: Principal, vpath: string) {
  if (p.kind === "admin") return;
  const meta = await effectiveMeta(ctx, vpath);
  if (meta.passwordPath) throw forbidden("此目錄需要密碼，無法透過 WebDAV 存取", "password_required");
  if (vpath !== "/") {
    const parent = await effectiveMeta(ctx, dirname(vpath));
    if (isHidden(basename(vpath), vpath, parent.hidePatterns)) throw notFound("找不到此路徑");
  }
}

// ───────── 節點解析 ─────────
const toProps = (e: FileEntry, vpath: string): DavProps => ({
  vpath,
  name: vpath === "/" ? "/" : basename(vpath),
  isDir: e.isDir,
  size: e.size,
  modifiedAt: e.modifiedAt,
  mime: e.isDir ? undefined : e.mime ?? guessMime(e.name),
  etag: e.etag,
});

async function driverFor(ctx: AppContext, r: Resolved): Promise<StorageDriver> {
  const row = await ctx.storage.row(r.storageId);
  if (!row.enabled) throw forbidden("此儲存已停用");
  return ctx.storage.driverFor(row);
}

async function node(ctx: AppContext, mounts: MountRow[], vpath: string): Promise<Node> {
  const r = resolveIn(mounts, vpath);
  const virtual = virtualChildren(mounts, vpath);
  if (!r) {
    const exists = vpath === "/" || virtual.length > 0;
    return { vpath, r: null, driver: null, virtual, entry: exists ? { vpath, name: vpath === "/" ? "/" : basename(vpath), isDir: true } : null };
  }
  const driver = await driverFor(ctx, r);
  let e: FileEntry | null = null;
  try {
    e = await driver.stat(r.rel);
  } catch {
    e = null;
  }
  // 掛載點本身與上方有虛擬子目錄者一律視為目錄
  if (!e && (r.rest === "/" || virtual.length)) e = { name: basename(vpath), path: r.rel, isDir: true };
  return { vpath, r, driver, virtual, entry: e ? toProps(e, vpath) : null };
}

async function listChildren(ctx: AppContext, p: Principal, n: Node, mounts: MountRow[]): Promise<DavProps[]> {
  const out = new Map<string, DavProps>();
  if (n.r && n.driver?.list) {
    let cursor: string | undefined;
    do {
      const res = await n.driver.list(n.r.rel, { cursor, limit: 1000 });
      for (const e of res.entries) {
        const vp = (n.vpath === "/" ? "" : n.vpath) + "/" + e.name;
        out.set(e.name, toProps(e, vp));
      }
      cursor = res.cursor;
    } while (cursor && out.size < LIST_MAX);
  }
  for (const name of n.virtual) {
    const vp = (n.vpath === "/" ? "" : n.vpath) + "/" + name;
    out.set(name, { vpath: vp, name, isDir: true });
  }
  let items = [...out.values()];
  if (p.kind !== "admin") {
    const meta = await effectiveMeta(ctx, n.vpath);
    items = items.filter((i) => !isHidden(i.name, i.vpath, meta.hidePatterns));
    items = items.filter((i) => {
      const r = resolveIn(mounts, i.vpath);
      if (can(p, "webdav", { storageId: r?.storageId, mountId: r?.mount.id, path: i.vpath })) return true;
      // 虛擬目錄：底下任一可讀的掛載點就顯示
      return i.isDir && virtualVisible(p, mounts, i.vpath);
    });
  }
  return items.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

function need<K extends keyof StorageDriver>(d: StorageDriver | null, k: K, label: string): NonNullable<StorageDriver[K]> {
  const f = d?.[k];
  if (typeof f !== "function") throw new HttpError(405, "unsupported", `此儲存不支援${label}`);
  return (f as Function).bind(d) as NonNullable<StorageDriver[K]>;
}

const text = (status: number, msg: string, headers: Record<string, string> = {}) =>
  new Response(msg ? msg + "\n" : null, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

// ───────── 各方法 ─────────
async function propfind(ctx: AppContext, p: Principal, n: Node, depth: string, mounts: MountRow[]): Promise<Response> {
  if (!n.entry) throw notFound("找不到此路徑");
  const responses = [propResponse(n.entry)];
  if (n.entry.isDir && depth !== "0") for (const ch of await listChildren(ctx, p, n, mounts)) responses.push(propResponse(ch));
  return new Response(multistatus(responses), { status: 207, headers: { "content-type": "application/xml; charset=utf-8" } });
}

async function get(c: HdContext, n: Node, head: boolean, mounts: MountRow[]): Promise<Response> {
  if (!n.entry) throw notFound("找不到此路徑");
  const ctx = c.get("ctx");
  if (n.entry.isDir) {
    const items = await listChildren(ctx, c.get("principal"), n, mounts);
    const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
    const html = `<!doctype html><meta charset="utf-8"><title>${esc(n.vpath)}</title><h1>${esc(n.vpath)}</h1><ul>${items
      .map((i) => `<li><a href="${esc(hrefFor(i.vpath, i.isDir))}">${esc(i.name)}${i.isDir ? "/" : ""}</a></li>`)
      .join("")}</ul>`;
    return new Response(head ? null : html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const e = n.entry;
  const base: Record<string, string> = {
    "content-type": e.mime || "application/octet-stream",
    "accept-ranges": "bytes",
  };
  if (e.modifiedAt) base["last-modified"] = new Date(e.modifiedAt).toUTCString();
  const etag = propEtag(e);
  if (etag) base.etag = etag;
  if (head) {
    if (e.size !== undefined) base["content-length"] = String(e.size);
    return new Response(null, { status: 200, headers: base });
  }
  const req = c.req.raw;
  const t = await n.driver!.download(n.r!.rel, { request: req, filename: e.name, mime: e.mime });
  let res: Response;
  if (t.kind === "redirect") {
    if (!n.r!.mount.web_proxy) return new Response(null, { status: 302, headers: { location: t.url } });
    const h: Record<string, string> = {};
    const range = c.req.header("range");
    if (range) h.range = range;
    res = await ctx.driverCtx.fetch(t.url, { headers: h });
  } else res = t.response;
  // 驅動已處理 Range（206）或沒有請求 Range：原樣轉送
  const rangeH = c.req.header("range");
  if (res.status === 206 || !rangeH || !res.ok) return withHeaders(res, base);
  const size = e.size ?? (Number(res.headers.get("content-length")) || undefined);
  if (size === undefined || !res.body) return withHeaders(res, base);
  const r = parseRange(rangeH, size);
  if (r === null) return withHeaders(res, base);
  if (r === "invalid") {
    await res.body.cancel().catch(() => {});
    return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  }
  return new Response(sliceStream(res.body, r.start, r.end), {
    status: 206,
    headers: { ...base, "content-range": `bytes ${r.start}-${r.end}/${size}`, "content-length": String(r.end - r.start + 1) },
  });
}

function propEtag(e: DavProps): string | undefined {
  if (e.etag) return e.etag.startsWith('"') || e.etag.startsWith("W/") ? e.etag : `"${e.etag}"`;
  return `"${(e.size ?? 0).toString(16)}-${(e.modifiedAt ?? 0).toString(16)}"`;
}

function withHeaders(res: Response, h: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(h)) if (!headers.has(k)) headers.set(k, v);
  headers.delete("content-disposition");
  return new Response(res.body, { status: res.status, headers });
}

const fmtMB = (b: number) => `${Math.floor(b / 1024 / 1024)} MB`;

async function uploadLimit(ctx: AppContext, d: StorageDriver): Promise<number> {
  let limit = d.capabilities.maxProxyUploadBytes ?? Infinity;
  const setting = Number(await ctx.settings.get("webdavMaxUploadBytes")) || 0;
  if (setting > 0) limit = Math.min(limit, setting);
  if (ctx.platform === "workers") limit = Math.min(limit, WORKERS_BODY_LIMIT);
  return limit;
}

function tooLarge(limit: number, ctx: AppContext) {
  const why = ctx.platform === "workers" && limit === WORKERS_BODY_LIMIT ? "（Cloudflare Workers 請求體上限）" : "";
  return new HttpError(413, "payload_too_large", `檔案超過 WebDAV 上傳上限 ${fmtMB(limit)}${why}，請改用網頁上傳（瀏覽器直傳）`);
}

async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number, ctx: AppContext): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge(limit, ctx);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.byteLength);
  return out;
}

async function parentExists(ctx: AppContext, mounts: MountRow[], vpath: string): Promise<boolean> {
  const pn = await node(ctx, mounts, dirname(vpath));
  return !!pn.entry?.isDir;
}

async function put(c: HdContext, mounts: MountRow[], n: Node): Promise<Response> {
  const ctx = c.get("ctx");
  if (!n.r || n.r.rest === "/") throw forbidden("無法覆寫掛載點或虛擬目錄");
  if (n.entry?.isDir) throw new HttpError(405, "is_collection", "目標是資料夾");
  const doPut = need(n.driver, "put", "經 WebDAV 上傳");
  if (!(await parentExists(ctx, mounts, n.vpath))) throw conflict("上層資料夾不存在");
  const limit = await uploadLimit(ctx, n.driver!);
  const lenH = c.req.header("content-length");
  const len = lenH !== undefined && /^\d+$/.test(lenH) ? Number(lenH) : undefined;
  if (len !== undefined && len > limit) throw tooLarge(limit, ctx);
  const mime = c.req.header("content-type") || guessMime(basename(n.vpath));
  let body: ReadableStream<Uint8Array> | Uint8Array;
  let size: number;
  if (len !== undefined && len > 0 && c.req.raw.body) {
    body = c.req.raw.body;
    size = len;
  } else {
    body = await readCapped(c.req.raw.body, limit, ctx);
    size = body.byteLength;
  }
  await doPut(n.r.rel, body, { size, mime });
  return new Response(null, { status: n.entry ? 204 : 201 });
}

async function mkcol(c: HdContext, mounts: MountRow[], n: Node): Promise<Response> {
  const ctx = c.get("ctx");
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 0) throw new HttpError(415, "unsupported_media_type", "MKCOL 不接受請求內容");
  if (n.entry) throw new HttpError(405, "exists", "此路徑已存在");
  if (!n.r) throw forbidden("此路徑不在任何掛載點內");
  if (!(await parentExists(ctx, mounts, n.vpath))) throw conflict("上層資料夾不存在");
  await need(n.driver, "mkdir", "建立資料夾")(n.r.rel);
  return new Response(null, { status: 201 });
}

async function del(n: Node): Promise<Response> {
  if (!n.entry) throw notFound("找不到此路徑");
  if (!n.r || n.r.rest === "/" || n.virtual.length) throw forbidden("無法刪除掛載點或虛擬目錄");
  await need(n.driver, "delete", "刪除")([n.r.rel]);
  return new Response(null, { status: 204 });
}

async function copyFile(ctx: AppContext, src: Node, dst: Node) {
  const doPut = need(dst.driver, "put", "經後端寫入");
  const t = await src.driver!.download(src.r!.rel);
  const res = t.kind === "redirect" ? await ctx.driverCtx.fetch(t.url) : t.response;
  if (!res.ok || !res.body) throw new HttpError(502, "upstream", `讀取來源失敗（HTTP ${res.status}）`);
  const size = src.entry!.size ?? (Number(res.headers.get("content-length")) || 0);
  const limit = await uploadLimit(ctx, dst.driver!);
  if (size > limit) {
    await res.body.cancel().catch(() => {});
    throw tooLarge(limit, ctx);
  }
  await doPut(dst.r!.rel, res.body, { size, mime: src.entry!.mime });
}

async function moveCopy(c: HdContext, p: Principal, mounts: MountRow[], src: Node, move: boolean): Promise<Response> {
  const ctx = c.get("ctx");
  const destV = destinationToVpath(c.req.header("destination"));
  if (!destV) throw badRequest("Destination 標頭不正確（需指向 /dav/ 底下）");
  if (!src.entry) throw notFound("找不到來源");
  if (!src.r || src.r.rest === "/" || src.virtual.length) throw forbidden("無法搬移或複製掛載點／虛擬目錄");
  if (destV === src.vpath) throw forbidden("來源與目的地相同");
  if (destV.startsWith(src.vpath + "/")) throw forbidden("無法搬移或複製到自身底下");
  const dst = await node(ctx, mounts, destV);
  if (!dst.r || dst.r.rest === "/") throw forbidden("目的地不在掛載點內或為掛載點");
  check(p, "fs.write", destV, dst.r);
  await guard(ctx, p, destV);
  if (!(await parentExists(ctx, mounts, destV))) throw conflict("目的地的上層資料夾不存在");
  const overwrite = (c.req.header("overwrite") ?? "T").toUpperCase() !== "F";
  const existed = !!dst.entry;
  if (existed && !overwrite) throw new HttpError(412, "precondition_failed", "目的地已存在（Overwrite: F）");
  if (existed) await need(dst.driver, "delete", "刪除")([dst.r.rel]);

  const same = src.r.storageId === dst.r.storageId;
  if (same && move && src.driver!.rename) await src.driver!.rename(src.r.rel, dst.r.rel);
  else if (same && !move && src.driver!.copy) await src.driver!.copy(src.r.rel, dst.r.rel);
  else if (!src.entry.isDir) {
    await copyFile(ctx, src, dst);
    if (move) await need(src.driver, "delete", "刪除")([src.r.rel]);
  } else {
    // 跨儲存的資料夾：交給背景工作（fs.transfer）
    const pr = principalLabel(p);
    const payload = newTransferPayload(
      [{ src: { storageId: src.r.storageId, path: src.r.rel }, dst: { storageId: dst.r.storageId, path: dst.r.rel }, isDir: true }],
      move,
      `WebDAV ${move ? "搬移" : "複製"} ${src.vpath} → ${destV}`,
    );
    const id = await createTask(ctx, TRANSFER_KIND, payload, { createdBy: pr });
    return text(202, `已建立背景工作 ${id}，完成前目的地內容可能不完整`);
  }
  return new Response(null, { status: existed ? 204 : 201 });
}

const principalLabel = (p: Principal) => (p.kind === "anon" ? "anon" : `${p.kind}:${p.id}`);

async function lock(c: HdContext, vpath: string): Promise<Response> {
  const body = await c.req.text().catch(() => "");
  const existing = c.req.header("if")?.match(/<(opaquelocktoken:[^>]+)>/)?.[1];
  const token = existing ?? `opaquelocktoken:${crypto.randomUUID?.() ?? randomId(32)}`;
  const t = c.req.header("timeout")?.match(/Second-(\d+)/i)?.[1];
  const timeout = Math.min(Number(t) || 3600, 3600);
  const depth = c.req.header("depth") === "0" ? "0" : "infinity";
  const href = hrefFor(vpath, false);
  return new Response(lockResponse(token, href, extractOwner(body), timeout, depth), {
    status: 200,
    headers: { "content-type": "application/xml; charset=utf-8", "lock-token": `<${token}>` },
  });
}

// ───────── 主處理 ─────────
async function handle(c: HdContext): Promise<Response> {
  const method = c.req.method.toUpperCase();
  const davHeaders = { DAV: "1, 2", "MS-Author-Via": "DAV", Allow: ALLOW };
  if (method === "OPTIONS") return new Response(null, { status: 200, headers: { ...davHeaders, "content-length": "0" } });
  const ctx = c.get("ctx");
  const vpath = davPathToVpath(new URL(c.req.url).pathname);
  if (vpath === null) throw badRequest("路徑不正確", "invalid_path");
  const p = await davPrincipal(c);
  if (p.kind === "anon") throw unauthorized("請以管理員帳密或 API 金鑰（作為密碼）登入 WebDAV");
  c.set("principal", p);
  const mounts = await loadMounts(ctx);
  const r = resolveIn(mounts, vpath);
  const perm: Perm =
    method === "DELETE" || method === "MOVE" ? "fs.delete" : method === "PUT" || method === "MKCOL" || method === "PROPPATCH" ? "fs.write" : "webdav";
  check(p, perm, vpath, r, mounts);
  if (method === "LOCK" || method === "UNLOCK") {
    if (method === "UNLOCK") return new Response(null, { status: 204 });
    return lock(c, vpath);
  }
  await guard(ctx, p, vpath);
  const n = await node(ctx, mounts, vpath);
  switch (method) {
    case "PROPFIND":
      return propfind(ctx, p, n, c.req.header("depth") ?? "1", mounts);
    case "PROPPATCH":
      if (!n.entry) throw notFound("找不到此路徑");
      return new Response(proppatchResponse(hrefFor(vpath, n.entry.isDir), await c.req.text()), {
        status: 207,
        headers: { "content-type": "application/xml; charset=utf-8" },
      });
    case "GET":
    case "HEAD":
      return get(c, n, method === "HEAD", mounts);
    case "PUT":
      return put(c, mounts, n);
    case "MKCOL":
      return mkcol(c, mounts, n);
    case "DELETE":
      return del(n);
    case "MOVE":
    case "COPY":
      return moveCopy(c, p, mounts, n, method === "MOVE");
  }
  return text(405, "不支援的方法", { Allow: ALLOW });
}

export const webdavModule: HdModule = {
  name: "webdav",
  settings: [{ key: "webdavMaxUploadBytes", default: 0, label: "WebDAV 單檔上傳上限（位元組，0 = 依儲存與平台上限）" }],
  routes(app) {
    app.on(METHODS, [DAV_PREFIX, `${DAV_PREFIX}/*`], async (c) => {
      try {
        return await handle(c);
      } catch (e) {
        if (e instanceof HttpError) {
          const h: Record<string, string> = {};
          if (e.status === 401) h["WWW-Authenticate"] = REALM;
          return text(e.status, e.message, h);
        }
        console.error("[webdav]", e);
        return text(500, "伺服器內部錯誤");
      }
    });
  },
};
