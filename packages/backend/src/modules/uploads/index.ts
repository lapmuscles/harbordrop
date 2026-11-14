import { anonClientIp, hitAnonLimit } from "../../core/anonlimit";
import type { HdModule } from "../types";
import type { AppContext, HdContext } from "../../core/context";
import { can, principalId } from "../../core/auth";
import { randomId, randomToken, sha256Hex, timingSafeEqual } from "../../core/crypto";
import { badRequest, forbidden, HttpError, notFound } from "../../core/errors";
import { guessMime, normalizePath } from "../../storage/util";
import type { UploadSessionView } from "../../storage/types";
import { createShare, prepareShareOptions, shareInfo } from "../shares/service";
import type { UploadInitRequest, UploadInitResponse, UploadCompleteResponse } from "@harbordrop/shared";

/**
 * 上傳工作階段（瀏覽器直傳）：
 *   POST   /api/uploads                     建立工作階段（回傳 uploadToken 與協定參數）
 *   GET    /api/uploads/:id                 查詢狀態（續傳用）
 *   ALL    /api/uploads/:id/action/:name/*  協定步驟（交給驅動 uploadAction）
 *   POST   /api/uploads/:id/chunk?index=N   chunk-relay：上傳第 N 片（原始位元組，經後端轉送到渠道）
 *   GET    /api/uploads/:id/chunk           chunk-relay：已收到的分片（續傳用）
 *   POST   /api/uploads/:id/complete        完成並建立分享
 *   DELETE /api/uploads/:id                 中止
 * 後續請求以 X-Upload-Token 標頭驗證（匿名上傳者亦可續傳）。
 */

const SESSION_TTL_MS = 24 * 3600_000;

interface SessionRow {
  id: string;
  token_hash: string;
  storage_id: number;
  protocol: string;
  object_path: string;
  filename: string;
  size: number;
  mime: string | null;
  sha256: string | null;
  state: string;
  provider_upload_id: string | null;
  part_size: number | null;
  meta: string;
  share_options: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

const view = (r: SessionRow): UploadSessionView => ({
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

export function sanitizeFilename(name: string): string {
  const s = name.replace(/[\\/\x00-\x1f\x7f]+/g, "_").replace(/^\.+/, "").trim().slice(0, 200);
  return s || "file";
}

export function renderUploadPath(template: string, filename: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const p = template
    .replace("{yyyy}", String(now.getUTCFullYear()))
    .replace("{mm}", pad(now.getUTCMonth() + 1))
    .replace("{dd}", pad(now.getUTCDate()))
    .replace("{rand}", randomId(8))
    .replace("{name}", filename);
  return normalizePath(p.includes(filename) ? p : `${p}/${filename}`);
}

async function loadSession(c: HdContext): Promise<SessionRow> {
  const ctx = c.get("ctx");
  const r = await ctx.db.first<SessionRow>("SELECT * FROM upload_sessions WHERE id = ?", [c.req.param("id")]);
  if (!r) throw notFound("找不到上傳工作階段");
  const tok = c.req.header("x-upload-token") ?? "";
  if (!timingSafeEqual(await sha256Hex(tok), r.token_hash)) throw forbidden("上傳權杖無效");
  if (r.expires_at < Date.now()) throw new HttpError(410, "session_expired", "上傳工作階段已過期");
  return r;
}

async function patchSession(ctx: AppContext, id: string, patch: { meta?: Record<string, unknown>; state?: string }, old: SessionRow) {
  const meta = patch.meta ? JSON.stringify({ ...JSON.parse(old.meta), ...patch.meta }) : old.meta;
  await ctx.db.run("UPDATE upload_sessions SET meta = ?, state = ?, updated_at = ? WHERE id = ?", [meta, patch.state ?? old.state, Date.now(), id]);
}

function origin(c: HdContext): string {
  const env = c.get("ctx").env.PUBLIC_URL;
  if (env) return env.replace(/\/+$/, "");
  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? u.host;
  return `${proto}://${host}`;
}

export const uploadsModule: HdModule = {
  name: "uploads",
  routes(app) {
    app.post("/api/uploads", async (c) => {
      const ctx = c.get("ctx");
      const p = c.get("principal");
      const b = await c.req.json<UploadInitRequest>();
      if (!b.filename || !Number.isFinite(b.size) || b.size < 0) throw badRequest("缺少檔名或大小");
      const row = await ctx.storage.row(Number(b.storageId));
      if (!row.enabled) throw badRequest("此儲存已停用");
      const anonymous = p.kind === "anon";
      if (anonymous) {
        if (!(await ctx.settings.get("allowAnonymousUpload")) || !row.allow_anonymous_upload) throw forbidden("未開放匿名上傳");
        const max = Number(await ctx.settings.get("anonymousMaxBytes")) || 0;
        if (max && b.size > max) throw badRequest(`檔案超過匿名上傳上限（${max} 位元組）`, "too_large");
        await hitAnonLimit(ctx, "upload", anonClientIp(c));
      } else if (!can(p, "upload", { storageId: row.id, path: "/" })) throw forbidden();
      const driver = await ctx.storage.driverFor(row);
      if (!driver.initUpload) throw badRequest("此儲存不支援瀏覽器直傳");
      const filename = sanitizeFilename(b.filename);
      const objectPath = renderUploadPath(String(await ctx.settings.get("uploadPathTemplate")), filename);
      const shareOpts = await prepareShareOptions(ctx, b.share, { anonymous });
      const mime = b.mime || guessMime(filename);
      const init = await driver.initUpload({ path: objectPath, filename, size: b.size, mime, origin: c.req.header("origin") ?? origin(c) });
      const id = randomId(16);
      const token = randomToken(24);
      const now = Date.now();
      await ctx.db.run(
        `INSERT INTO upload_sessions (id, token_hash, storage_id, protocol, object_path, filename, size, mime, state, provider_upload_id, part_size, meta, share_options, created_by, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'init', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, await sha256Hex(token), row.id, init.protocol, objectPath, filename, b.size, mime, init.providerUploadId ?? null, init.partSize ?? null, JSON.stringify(init.meta ?? {}), JSON.stringify(shareOpts), principalId(p), now, now, now + SESSION_TTL_MS],
      );
      const res: UploadInitResponse = { sessionId: id, uploadToken: token, protocol: init.protocol, client: init.client, partSize: init.partSize };
      return c.json(res, 201);
    });

    app.get("/api/uploads/:id", async (c) => {
      const r = await loadSession(c);
      return c.json({ id: r.id, state: r.state, protocol: r.protocol, filename: r.filename, size: r.size, partSize: r.part_size, expiresAt: r.expires_at });
    });

    const action = async (c: HdContext) => {
      const ctx = c.get("ctx");
      const r = await loadSession(c);
      if (["completed", "aborted"].includes(r.state)) throw badRequest("工作階段已結束");
      const driver = await ctx.storage.driver(r.storage_id);
      if (!driver.uploadAction) throw badRequest("此儲存沒有上傳動作");
      const name = c.req.param("name")!;
      const prefix = `/api/uploads/${r.id}/action/${name}`;
      const path = new URL(c.req.url).pathname;
      const subpath = path.startsWith(prefix) ? decodeURI(path.slice(prefix.length)) : "";
      const o = origin(c);
      const res = await driver.uploadAction(view(r), name, {
        subpath,
        request: c.req.raw,
        origin: o,
        actionBase: `${o}/api/uploads/${r.id}/action`,
      });
      if (res.meta || res.state) await patchSession(ctx, r.id, res, r);
      return res.response;
    };
    app.all("/api/uploads/:id/action/:name", action);
    app.all("/api/uploads/:id/action/:name/*", action);

    // —— chunk-relay：每片經後端轉送到渠道（片大小由驅動決定）——
    app.post("/api/uploads/:id/chunk", async (c) => {
      const ctx = c.get("ctx");
      const r = await loadSession(c);
      if (["completed", "aborted"].includes(r.state)) throw badRequest("工作階段已結束");
      const driver = await ctx.storage.driver(r.storage_id);
      if (!driver.uploadChunk) throw badRequest("此儲存不支援分片中繼上傳");
      const raw = c.req.query("index");
      const index = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(index)) throw badRequest("缺少或無效的分片編號 index");
      const body = new Uint8Array(await c.req.arrayBuffer());
      const res = await driver.uploadChunk(view(r), index, body);
      if (r.state !== "uploading") await patchSession(ctx, r.id, { state: "uploading" }, r);
      return c.json(res);
    });

    app.get("/api/uploads/:id/chunk", async (c) => {
      const ctx = c.get("ctx");
      const r = await loadSession(c);
      const driver = await ctx.storage.driver(r.storage_id);
      if (!driver.listChunks) throw badRequest("此儲存不支援分片中繼上傳");
      return c.json({ chunks: await driver.listChunks(view(r)), partSize: r.part_size, size: r.size });
    });

    app.post("/api/uploads/:id/complete", async (c) => {
      const ctx = c.get("ctx");
      const r = await loadSession(c);
      if (r.state === "completed") throw badRequest("已完成");
      const driver = await ctx.storage.driver(r.storage_id);
      const body = await c.req.json().catch(() => ({}));
      const { entry } = await driver.completeUpload!(view(r), body);
      const share = await createShare(
        ctx,
        { storageId: r.storage_id, objectPath: r.object_path, filename: r.filename, size: entry.size ?? r.size, mime: r.mime, sha256: entry.sha256 ?? null },
        JSON.parse(r.share_options),
        r.created_by,
      );
      await ctx.db.run("UPDATE upload_sessions SET state = 'completed', sha256 = ?, updated_at = ? WHERE id = ?", [entry.sha256 ?? null, Date.now(), r.id]);
      const res: UploadCompleteResponse = { share: shareInfo(share), url: `${origin(c)}/f/${share.slug}` };
      return c.json(res);
    });

    app.delete("/api/uploads/:id", async (c) => {
      const ctx = c.get("ctx");
      const r = await loadSession(c);
      const driver = await ctx.storage.driver(r.storage_id);
      await driver.abortUpload?.(view(r)).catch(() => {});
      await ctx.db.run("UPDATE upload_sessions SET state = 'aborted', updated_at = ? WHERE id = ?", [Date.now(), r.id]);
      return c.json({ ok: true });
    });
  },

  /** 清理過期的工作階段（未完成者通知驅動中止） */
  async cron(ctx) {
    const rows = await ctx.db.all<SessionRow>("SELECT * FROM upload_sessions WHERE expires_at < ? LIMIT 50", [Date.now()]);
    for (const r of rows) {
      if (!["completed", "aborted"].includes(r.state)) {
        const d = await ctx.storage.driver(r.storage_id).catch(() => null);
        await d?.abortUpload?.(view(r)).catch(() => {});
      }
      await ctx.db.run("DELETE FROM upload_sessions WHERE id = ?", [r.id]);
    }
  },
};
