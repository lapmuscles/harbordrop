import type { HdModule } from "../types";
import type { AppContext, HdContext } from "../../core/context";
import { can, principalId, requireAdmin } from "../../core/auth";
import { randomId, randomToken, sha256Hex, timingSafeEqual } from "../../core/crypto";
import { badRequest, conflict, forbidden, HttpError, notFound, unauthorized } from "../../core/errors";
import { contentDisposition, guessMime, joinPath } from "../../storage/util";
import type { FileEntry, StorageDriver, UploadSessionView } from "../../storage/types";
import { createShare, prepareShareOptions, shareInfo } from "../shares/service";
import { assertUnlocked, effectiveMeta, isHidden, isHiddenPath } from "../fsmeta/service";
import { createTask } from "../tasks/service";
import { basename, dirname, loadMounts, resolveIn, virtualChildren, vnorm, type MountRow, type Resolved } from "./mounts";
import { newTransferPayload, TRANSFER_KIND, type TransferItem } from "./transfer";

/**
 * 虛擬目錄與檔案操作（規格：docs/MODULES-zhTW.md#fs）
 *   GET  /api/fs/list?path=&cursor=&limit=   GET /api/fs/get?path=   GET /api/fs/download?path=&inline=1
 *   POST /api/fs/mkdir {path}   rename {path,name}   delete {paths}   copy|move {paths,dst}
 *   POST /api/fs/upload/init {path,filename,size,mime} → 沿用 /api/uploads/:id/action/*，再 POST /api/fs/upload/complete
 *   PUT  /api/fs/upload/put?path=（不支援直傳的儲存，經後端 put）
 *   POST /api/fs/share {path, share}
 *   管理：GET/POST /api/admin/mounts、PATCH/DELETE /api/admin/mounts/:id
 * 同儲存的 copy/move 直接呼叫驅動；跨儲存（或驅動無原生 copy/rename）建立 tasks（kind=fs.transfer）。
 */

type Perm = "fs.read" | "fs.write" | "fs.delete" | "share";

interface Target {
  vpath: string;
  r: Resolved;
  driver: StorageDriver;
}

const isAdmin = (c: HdContext) => c.get("principal").kind === "admin";

async function authorize(c: HdContext, perm: Perm, vpath: string, r: Resolved | null) {
  const ctx = c.get("ctx");
  const p = c.get("principal");
  if (p.kind === "anon") {
    if (perm === "fs.read" && (await ctx.settings.get("fsPublicBrowse"))) return;
    throw perm === "fs.read" ? unauthorized("未開放匿名瀏覽，請先登入") : unauthorized();
  }
  if (!can(p, perm, { storageId: r?.storageId, mountId: r?.mount.id, path: vpath })) throw forbidden();
  if (r && perm !== "fs.read" && perm !== "share" && r.mount.readonly) throw forbidden("此掛載為唯讀", "readonly");
}

/**
 * 密碼與隱藏檢查（管理員略過）：路徑需已解鎖，且自身與所有祖先的名稱都不得被其上層的隱藏規則命中
 * （例如 /pub 隱藏 secret 時，/pub/secret/a.txt 的 list／get／download 也一律 404）。
 */
async function guard(c: HdContext, vpath: string) {
  const ctx = c.get("ctx");
  await assertUnlocked(c, await effectiveMeta(ctx, vpath));
  if (vpath !== "/" && !isAdmin(c) && (await isHiddenPath(ctx, vpath))) throw notFound("找不到此路徑");
}

async function target(c: HdContext, rawPath: unknown, perm: Perm, mounts?: MountRow[]): Promise<Target> {
  const ctx = c.get("ctx");
  const vpath = vnorm(rawPath);
  const r = resolveIn(mounts ?? (await loadMounts(ctx)), vpath);
  if (!r) throw notFound(vpath === "/" ? "尚未設定任何掛載" : "此路徑不在任何掛載點內");
  await authorize(c, perm, vpath, r);
  await guard(c, vpath);
  const row = await ctx.storage.row(r.storageId);
  if (!row.enabled) throw badRequest("此儲存已停用");
  return { vpath, r, driver: await ctx.storage.driverFor(row) };
}

function need<K extends keyof StorageDriver>(d: StorageDriver, k: K, label: string): NonNullable<StorageDriver[K]> {
  const f = d[k];
  if (typeof f !== "function") throw badRequest(`此儲存不支援${label}`, "unsupported");
  return (f as Function).bind(d) as NonNullable<StorageDriver[K]>;
}

const entryOut = (e: FileEntry, vpath: string, extra: Record<string, unknown> = {}) => ({
  name: e.name,
  path: vpath,
  isDir: e.isDir,
  size: e.size ?? null,
  modifiedAt: e.modifiedAt ?? null,
  mime: e.isDir ? null : e.mime ?? guessMime(e.name),
  ...extra,
});

function validName(n: unknown): string {
  const s = String(n ?? "").trim();
  if (!s || s === "." || s === ".." || /[\\/\x00-\x1f\x7f]/.test(s) || s.length > 255) throw badRequest("名稱不正確", "invalid_name");
  return s;
}

function origin(c: HdContext): string {
  const env = c.get("ctx").env.PUBLIC_URL;
  if (env) return env.replace(/\/+$/, "");
  const u = new URL(c.req.url);
  return `${c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "")}://${c.req.header("x-forwarded-host") ?? u.host}`;
}

function pathsOf(b: any): string[] {
  const a = Array.isArray(b?.paths) ? b.paths : b?.path !== undefined ? [b.path] : [];
  if (!a.length) throw badRequest("請指定路徑");
  if (a.length > 1000) throw badRequest("一次最多 1000 個項目");
  return a.map(vnorm);
}

// ───────── 管理：掛載 ─────────
function mountDto(m: MountRow & { storage_name?: string }) {
  return {
    id: m.id,
    mountPath: m.mount_path,
    storageId: m.storage_id,
    storageName: m.storage_name ?? null,
    rootPath: m.root_path,
    readonly: !!m.readonly,
    enabled: !!m.enabled,
    webProxy: !!m.web_proxy,
    cacheTtl: m.cache_ttl,
    sort: m.sort,
    options: JSON.parse(m.options || "{}"),
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

async function mountInput(ctx: AppContext, b: any, old?: MountRow) {
  const mountPath = b.mountPath !== undefined ? vnorm(b.mountPath) : old?.mount_path;
  if (!mountPath) throw badRequest("請填寫掛載路徑");
  const storageId = b.storageId !== undefined ? Number(b.storageId) : old?.storage_id;
  if (!storageId) throw badRequest("請選擇儲存");
  await ctx.storage.row(storageId);
  const clash = await ctx.db.first<{ id: number }>("SELECT id FROM mounts WHERE mount_path = ?", [mountPath]);
  if (clash && clash.id !== old?.id) throw conflict("此掛載路徑已被使用", "mount_path_taken");
  const bool = (v: unknown, d: number) => (v === undefined ? d : v ? 1 : 0);
  if (b.options !== undefined && (typeof b.options !== "object" || Array.isArray(b.options) || b.options === null)) throw badRequest("options 必須是物件");
  return {
    mountPath,
    storageId,
    rootPath: b.rootPath !== undefined ? vnorm(b.rootPath) : old?.root_path ?? "/",
    readonly: bool(b.readonly, old?.readonly ?? 0),
    enabled: bool(b.enabled, old?.enabled ?? 1),
    webProxy: bool(b.webProxy, old?.web_proxy ?? 0),
    cacheTtl: b.cacheTtl !== undefined ? Math.max(0, Math.floor(Number(b.cacheTtl) || 0)) : old?.cache_ttl ?? 0,
    sort: b.sort !== undefined ? Math.floor(Number(b.sort) || 0) : old?.sort ?? 0,
    options: b.options !== undefined ? JSON.stringify(b.options) : old?.options ?? "{}",
  };
}

const getMount = async (ctx: AppContext, id: number) =>
  ctx.db.first<MountRow & { storage_name: string }>("SELECT m.*, s.name AS storage_name FROM mounts m LEFT JOIN storages s ON s.id = m.storage_id WHERE m.id = ?", [id]);

// ───────── fs 上傳工作階段 ─────────
interface SessionRow {
  id: string;
  token_hash: string;
  storage_id: number;
  protocol: string;
  object_path: string;
  filename: string;
  size: number;
  mime: string | null;
  state: string;
  provider_upload_id: string | null;
  part_size: number | null;
  meta: string;
  share_options: string;
  expires_at: number;
}
const sessionView = (r: SessionRow): UploadSessionView => ({
  id: r.id,
  protocol: r.protocol,
  objectPath: r.object_path,
  filename: r.filename,
  size: r.size,
  mime: r.mime,
  providerUploadId: r.provider_upload_id,
  partSize: r.part_size,
  meta: JSON.parse(r.meta),
  state: r.state,
});

export const fsModule: HdModule = {
  name: "fs",
  settings: [{ key: "fsPublicBrowse", default: false, public: true, label: "允許匿名瀏覽檔案（/api/fs）" }],
  routes(app) {
    // ── 讀取 ──
    app.get("/api/fs/list", async (c) => {
      const ctx = c.get("ctx");
      const vpath = vnorm(c.req.query("path") ?? "/");
      const mounts = await loadMounts(ctx);
      const r = resolveIn(mounts, vpath);
      const virt = virtualChildren(mounts, vpath);
      if (!r && !virt.length && vpath !== "/") throw notFound("找不到此路徑");
      await authorize(c, "fs.read", vpath, r);
      await guard(c, vpath);
      const meta = await effectiveMeta(ctx, vpath);
      const admin = isAdmin(c);
      const cursorIn = c.req.query("cursor") || undefined;
      const out: ReturnType<typeof entryOut>[] = [];
      let cursor: string | undefined;
      if (r) {
        const driver = await ctx.storage.driver(r.storageId);
        const list = need(driver, "list", "列目錄");
        const res = await list(r.rel, { cursor: cursorIn, limit: Number(c.req.query("limit")) || undefined });
        cursor = res.cursor;
        for (const e of res.entries) out.push(entryOut(e, joinPath(vpath, e.name)));
      }
      if (!cursorIn) {
        const have = new Set(out.map((e) => e.name));
        for (const name of virt) {
          if (have.has(name)) continue;
          out.unshift({ name, path: joinPath(vpath, name), isDir: true, size: null, modifiedAt: null, mime: null, mount: true } as any);
        }
      }
      const entries = out
        .map((e) => (isHidden(e.name, e.path, meta.hidePatterns) ? (admin ? { ...e, hidden: true } : null) : e))
        .filter(Boolean);
      return c.json({
        path: vpath,
        entries,
        cursor: cursor ?? null,
        mount: r ? { id: r.mount.id, path: r.mount.mount_path, readonly: !!r.mount.readonly } : null,
        headerMd: meta.headerMd,
        readmeMd: meta.readmeMd,
      });
    });

    app.get("/api/fs/get", async (c) => {
      const ctx = c.get("ctx");
      const vpath = vnorm(c.req.query("path") ?? "/");
      const mounts = await loadMounts(ctx);
      const r = resolveIn(mounts, vpath);
      if (!r || (r.mount.mount_path === vpath && r.rest === "/")) {
        // 虛擬目錄或掛載點本身
        if (!r && !virtualChildren(mounts, vpath).length && vpath !== "/") throw notFound("找不到此路徑");
        await authorize(c, "fs.read", vpath, r);
        await guard(c, vpath);
        return c.json(entryOut({ name: basename(vpath) || "/", path: vpath, isDir: true }, vpath, { mount: !!r }));
      }
      const t = await target(c, vpath, "fs.read", mounts);
      const st = await t.driver.stat(t.r.rel);
      if (!st) throw notFound("找不到此檔案");
      return c.json(entryOut({ ...st, name: basename(vpath) }, vpath, st.isDir ? {} : { downloadUrl: `/api/fs/download?path=${encodeURIComponent(vpath)}` }));
    });

    app.get("/api/fs/download", async (c) => {
      const ctx = c.get("ctx");
      const t = await target(c, c.req.query("path"), "fs.read");
      const name = basename(t.vpath);
      const inline = c.req.query("inline") === "1";
      const st = await t.driver.stat(t.r.rel);
      if (!st) throw notFound("找不到此檔案");
      if (st.isDir) throw badRequest("無法下載目錄");
      const mime = st.mime ?? guessMime(name);
      const tgt = await t.driver.download(t.r.rel, { filename: name, inline, mime, request: c.req.raw });
      if (tgt.kind === "response") return tgt.response;
      if (!t.r.mount.web_proxy) return c.redirect(tgt.url, 302);
      const range = c.req.header("range");
      const up = await ctx.driverCtx.fetch(tgt.url, { headers: range ? { range } : {} });
      const h = new Headers();
      for (const k of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
        const v = up.headers.get(k);
        if (v) h.set(k, v);
      }
      h.set("content-type", mime);
      h.set("content-disposition", contentDisposition(name, inline));
      return new Response(up.body, { status: up.status, headers: h });
    });

    // ── 寫入 ──
    app.post("/api/fs/mkdir", async (c) => {
      const b = await c.req.json<any>();
      const t = await target(c, b.path, "fs.write");
      if (t.r.rest === "/") throw badRequest("目錄已存在");
      await need(t.driver, "mkdir", "建立目錄")(t.r.rel);
      return c.json({ ok: true, path: t.vpath }, 201);
    });

    app.post("/api/fs/rename", async (c) => {
      const b = await c.req.json<any>();
      const t = await target(c, b.path, "fs.write");
      if (t.r.rest === "/") throw badRequest("無法重新命名掛載點，請到掛載管理修改");
      const name = validName(b.name);
      const to = joinPath(dirname(t.r.rel), name);
      if (await t.driver.stat(to)) throw conflict("已有同名項目");
      await need(t.driver, "rename", "重新命名")(t.r.rel, to);
      return c.json({ ok: true, path: joinPath(dirname(t.vpath), name) });
    });

    app.post("/api/fs/delete", async (c) => {
      const ctx = c.get("ctx");
      const paths = pathsOf(await c.req.json<any>());
      const mounts = await loadMounts(ctx);
      const groups = new Map<number, { driver: StorageDriver; rels: string[] }>();
      for (const p of paths) {
        const t = await target(c, p, "fs.delete", mounts);
        if (t.r.rest === "/") throw badRequest("無法刪除掛載點本身");
        const g = groups.get(t.r.storageId) ?? { driver: t.driver, rels: [] };
        g.rels.push(t.r.rel);
        groups.set(t.r.storageId, g);
      }
      for (const g of groups.values()) await need(g.driver, "delete", "刪除")(g.rels);
      return c.json({ ok: true, deleted: paths.length });
    });

    const transfer = (move: boolean) => async (c: HdContext) => {
      const ctx = c.get("ctx");
      const b = await c.req.json<any>();
      const paths = pathsOf(b);
      const mounts = await loadMounts(ctx);
      const dst = await target(c, b.dst, "fs.write", mounts);
      const dstSt = dst.r.rest === "/" ? { isDir: true } : await dst.driver.stat(dst.r.rel);
      if (!dstSt?.isDir) throw badRequest("目的地必須是已存在的目錄");
      const queued: TransferItem[] = [];
      let direct = 0;
      for (const p of paths) {
        const src = await target(c, p, move ? "fs.delete" : "fs.read", mounts);
        if (src.r.rest === "/") throw badRequest("無法複製或搬移掛載點本身");
        if (dst.vpath === src.vpath || dst.vpath.startsWith(src.vpath + "/")) throw badRequest("無法複製或搬移到自身底下");
        const to = joinPath(dst.r.rel, basename(src.r.rel));
        if (src.r.storageId === dst.r.storageId && to === src.r.rel) throw badRequest("來源與目的地相同");
        if (await dst.driver.stat(to)) throw conflict(`目的地已有「${basename(to)}」`);
        if (src.r.storageId === dst.r.storageId) {
          const fn = move ? src.driver.rename : src.driver.copy;
          if (fn) {
            await fn.call(src.driver, src.r.rel, to);
            direct++;
            continue;
          }
        }
        queued.push({ src: { storageId: src.r.storageId, path: src.r.rel }, dst: { storageId: dst.r.storageId, path: to } });
      }
      let taskId: string | null = null;
      if (queued.length) {
        taskId = await createTask(ctx, TRANSFER_KIND, newTransferPayload(queued, move, `${move ? "搬移" : "複製"}到 ${dst.vpath}`), {
          createdBy: principalId(c.get("principal")),
          total: queued.length,
        });
      }
      return c.json({ ok: true, done: direct, queued: queued.length, taskId }, taskId ? 202 : 200);
    };
    app.post("/api/fs/copy", transfer(false));
    app.post("/api/fs/move", transfer(true));

    // ── 上傳 ──
    app.post("/api/fs/upload/init", async (c) => {
      const ctx = c.get("ctx");
      const b = await c.req.json<any>();
      const filename = validName(b.filename);
      const size = Number(b.size);
      if (!Number.isFinite(size) || size < 0) throw badRequest("缺少檔案大小");
      const t = await target(c, b.path ?? "/", "fs.write");
      const rel = joinPath(t.r.rel, filename);
      const vpath = joinPath(t.vpath, filename);
      const mime = b.mime || guessMime(filename);
      if (!t.driver.initUpload) {
        if (!t.driver.put) throw badRequest("此儲存不支援上傳", "unsupported");
        const max = t.driver.capabilities.maxProxyUploadBytes;
        if (max !== undefined && size > max) throw badRequest(`檔案超過此儲存經後端上傳的上限（${max} 位元組）`, "too_large");
        return c.json({ protocol: "proxy", putUrl: `/api/fs/upload/put?path=${encodeURIComponent(vpath)}` }, 201);
      }
      const init = await t.driver.initUpload({ path: rel, filename, size, mime });
      const id = randomId(16);
      const token = randomToken(24);
      const now = Date.now();
      await ctx.db.run(
        `INSERT INTO upload_sessions (id, token_hash, storage_id, protocol, object_path, filename, size, mime, state, provider_upload_id, part_size, meta, share_options, created_by, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'init', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, await sha256Hex(token), t.r.storageId, init.protocol, rel, filename, size, mime, init.providerUploadId ?? null, init.partSize ?? null, JSON.stringify(init.meta ?? {}), JSON.stringify({ fs: true, vpath }), principalId(c.get("principal")), now, now, now + 24 * 3600_000],
      );
      return c.json({ sessionId: id, uploadToken: token, protocol: init.protocol, client: init.client, partSize: init.partSize, actionBase: `/api/uploads/${id}/action`, completeUrl: "/api/fs/upload/complete", path: vpath }, 201);
    });

    app.post("/api/fs/upload/complete", async (c) => {
      const ctx = c.get("ctx");
      const b = await c.req.json<any>().catch(() => ({}));
      const r = await ctx.db.first<SessionRow>("SELECT * FROM upload_sessions WHERE id = ?", [String(b.sessionId ?? "")]);
      if (!r) throw notFound("找不到上傳工作階段");
      if (!timingSafeEqual(await sha256Hex(c.req.header("x-upload-token") ?? ""), r.token_hash)) throw forbidden("上傳權杖無效");
      if (r.expires_at < Date.now()) throw new HttpError(410, "session_expired", "上傳工作階段已過期");
      const opts = JSON.parse(r.share_options || "{}");
      if (!opts.fs) throw badRequest("此工作階段不是檔案管理上傳，請改用 /api/uploads/:id/complete");
      if (r.state === "completed" || r.state === "aborted") throw badRequest("工作階段已結束");
      const driver = await ctx.storage.driver(r.storage_id);
      const { entry } = await need(driver, "completeUpload", "瀏覽器直傳")(sessionView(r), b.body ?? {});
      await ctx.db.run("UPDATE upload_sessions SET state = 'completed', sha256 = ?, updated_at = ? WHERE id = ?", [entry.sha256 ?? null, Date.now(), r.id]);
      return c.json({ ok: true, entry: entryOut({ ...entry, name: r.filename }, opts.vpath) });
    });

    app.put("/api/fs/upload/put", async (c) => {
      const t = await target(c, c.req.query("path"), "fs.write");
      if (t.r.rest === "/") throw badRequest("路徑不正確");
      const put = need(t.driver, "put", "經後端上傳");
      const size = Number(c.req.header("content-length")) || 0;
      const max = t.driver.capabilities.maxProxyUploadBytes;
      if (max !== undefined && size > max) throw badRequest(`檔案超過此儲存經後端上傳的上限（${max} 位元組）`, "too_large");
      const body = c.req.raw.body ?? new Uint8Array();
      const e = await put(t.r.rel, body, { size, mime: c.req.header("content-type") || guessMime(basename(t.vpath)) });
      return c.json({ ok: true, entry: entryOut({ ...e, name: basename(t.vpath) }, t.vpath) }, 201);
    });

    // ── 分享 ──
    app.post("/api/fs/share", async (c) => {
      const ctx = c.get("ctx");
      const b = await c.req.json<any>();
      const t = await target(c, b.path, "share");
      const st = await t.driver.stat(t.r.rel);
      if (!st) throw notFound("找不到此檔案");
      if (st.isDir) throw badRequest("目前只能分享單一檔案");
      const opts = await prepareShareOptions(ctx, b.share, { anonymous: false });
      const name = basename(t.vpath);
      const share = await createShare(
        ctx,
        { storageId: t.r.storageId, objectPath: t.r.rel, filename: name, size: st.size ?? 0, mime: st.mime ?? guessMime(name), sha256: st.sha256 ?? null },
        opts,
        principalId(c.get("principal")),
      );
      return c.json({ share: shareInfo(share), url: `${origin(c)}/f/${share.slug}` }, 201);
    });

    // ── 管理：掛載 ──
    app.get("/api/admin/mounts", async (c) => {
      requireAdmin(c);
      const rows = await c.get("ctx").db.all<MountRow & { storage_name: string }>(
        "SELECT m.*, s.name AS storage_name FROM mounts m LEFT JOIN storages s ON s.id = m.storage_id ORDER BY m.sort, m.mount_path",
      );
      return c.json({ mounts: rows.map(mountDto) });
    });

    app.post("/api/admin/mounts", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const v = await mountInput(ctx, await c.req.json<any>());
      const now = Date.now();
      const r = await ctx.db.run(
        "INSERT INTO mounts (mount_path, storage_id, root_path, readonly, enabled, web_proxy, cache_ttl, sort, options, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [v.mountPath, v.storageId, v.rootPath, v.readonly, v.enabled, v.webProxy, v.cacheTtl, v.sort, v.options, now, now],
      );
      return c.json(mountDto((await getMount(ctx, r.lastRowId))!), 201);
    });

    app.patch("/api/admin/mounts/:id", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const old = await getMount(ctx, Number(c.req.param("id")));
      if (!old) throw notFound("找不到此掛載");
      const v = await mountInput(ctx, await c.req.json<any>(), old);
      await ctx.db.run(
        "UPDATE mounts SET mount_path = ?, storage_id = ?, root_path = ?, readonly = ?, enabled = ?, web_proxy = ?, cache_ttl = ?, sort = ?, options = ?, updated_at = ? WHERE id = ?",
        [v.mountPath, v.storageId, v.rootPath, v.readonly, v.enabled, v.webProxy, v.cacheTtl, v.sort, v.options, Date.now(), old.id],
      );
      return c.json(mountDto((await getMount(ctx, old.id))!));
    });

    app.delete("/api/admin/mounts/:id", async (c) => {
      requireAdmin(c);
      const r = await c.get("ctx").db.run("DELETE FROM mounts WHERE id = ?", [Number(c.req.param("id"))]);
      if (!r.changes) throw notFound("找不到此掛載");
      return c.json({ ok: true });
    });
  },
};
