import type { HdModule } from "../types";
import type { HdContext } from "../../core/context";
import { requireAdmin } from "../../core/auth";
import { verifyPassword } from "../../core/crypto";
import { badRequest, gone, notFound, unauthorized } from "../../core/errors";
import { signToken, verifyToken } from "../../core/sign";
import { type ShareRow, shareInfo, shareStatus } from "./service";

/**
 * 檔案分享：
 *   GET  /api/shares/:slug           分享資訊（不計次）
 *   POST /api/shares/:slug/unlock    密碼解鎖 → 短效 token
 *   GET  /api/shares/:slug/content   下載／預覽（?inline=1；有密碼時需 ?t=token）。每次非續傳（無 Range 或 Range 從 0 起）計一次
 *   GET  /api/admin/shares           管理員列表；DELETE /api/admin/shares/:slug；PATCH 修改
 */

const UNLOCK_TTL = 6 * 3600;

async function load(c: HdContext): Promise<ShareRow> {
  const r = await c.get("ctx").db.first<ShareRow>("SELECT * FROM shares WHERE slug = ?", [c.req.param("slug")]);
  if (!r) throw notFound("分享不存在或已刪除");
  return r;
}

function assertAvailable(r: ShareRow) {
  const s = shareStatus(r);
  if (s === "expired") throw gone("分享已過期", "share_expired");
  if (s === "exhausted") throw gone("分享已達瀏覽次數上限", "share_exhausted");
}

export const sharesModule: HdModule = {
  name: "shares",
  routes(app) {
    app.get("/api/shares/:slug", async (c) => {
      const r = await load(c);
      assertAvailable(r);
      return c.json(shareInfo(r));
    });

    app.post("/api/shares/:slug/unlock", async (c) => {
      const ctx = c.get("ctx");
      const r = await load(c);
      assertAvailable(r);
      const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
      if (!r.password_hash) return c.json({ token: null });
      if (!password || !(await verifyPassword(password, r.password_hash))) throw unauthorized("密碼錯誤", "wrong_password");
      return c.json({ token: await signToken(ctx.env.APP_SECRET!, `share:${r.slug}:${r.password_hash.slice(-12)}`, UNLOCK_TTL) });
    });

    app.get("/api/shares/:slug/content", async (c) => {
      const ctx = c.get("ctx");
      const r = await load(c);
      assertAvailable(r);
      if (r.password_hash) {
        const t = c.req.query("t") ?? c.req.header("x-share-token");
        if (!(await verifyToken(ctx.env.APP_SECRET!, `share:${r.slug}:${r.password_hash.slice(-12)}`, t))) throw unauthorized("需要密碼", "password_required");
      }
      if (r.storage_id == null) throw gone("原始儲存已刪除");
      const range = c.req.header("range");
      const counts = !range || /^bytes=0-/.test(range);
      if (counts) {
        // 原子遞增；超過上限時不更新
        const u = await ctx.db.run("UPDATE shares SET views = views + 1 WHERE id = ? AND (max_views IS NULL OR views < max_views)", [r.id]);
        if (u.changes === 0) throw gone("分享已達瀏覽次數上限", "share_exhausted");
      }
      const driver = await ctx.storage.driver(r.storage_id);
      const inline = c.req.query("inline") === "1";
      const target = await driver.download(r.object_path, { filename: r.filename, inline, mime: r.mime ?? undefined, request: c.req.raw });
      if (target.kind === "redirect") return c.redirect(target.url, 302);
      return target.response;
    });

    app.get("/api/admin/shares", async (c) => {
      requireAdmin(c);
      const limit = Math.min(200, Number(c.req.query("limit")) || 50);
      const offset = Number(c.req.query("offset")) || 0;
      const db = c.get("ctx").db;
      const rows = await db.all<ShareRow & { storage_name: string | null }>(
        "SELECT s.*, st.name AS storage_name FROM shares s LEFT JOIN storages st ON st.id = s.storage_id ORDER BY s.id DESC LIMIT ? OFFSET ?",
        [limit, offset],
      );
      const total = (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM shares"))!.n;
      return c.json({ total, items: rows.map((r) => ({ ...shareInfo(r), id: r.id, storageId: r.storage_id, storageName: r.storage_name, objectPath: r.object_path, remark: r.remark, createdBy: r.created_by })) });
    });

    app.patch("/api/admin/shares/:slug", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const r = await load(c);
      const b = await c.req.json<{ expiresAt?: number | null; maxViews?: number | null; remark?: string | null; resetViews?: boolean }>();
      if (b.maxViews != null && b.maxViews < 0) throw badRequest("次數不可為負");
      await ctx.db.run("UPDATE shares SET expires_at = ?, max_views = ?, remark = ?, views = ?, updated_at = ? WHERE id = ?", [
        b.expiresAt !== undefined ? b.expiresAt : r.expires_at,
        b.maxViews !== undefined ? b.maxViews || null : r.max_views,
        b.remark !== undefined ? b.remark : r.remark,
        b.resetViews ? 0 : r.views,
        Date.now(),
        r.id,
      ]);
      return c.json({ ok: true });
    });

    /** 刪除分享；?deleteFile=1 同時刪除儲存中的檔案 */
    app.delete("/api/admin/shares/:slug", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const r = await load(c);
      if (c.req.query("deleteFile") === "1" && r.storage_id != null) {
        const d = await ctx.storage.driver(r.storage_id);
        if (!d.delete) throw badRequest("此儲存不支援刪除");
        await d.delete([r.object_path]);
      }
      await ctx.db.run("DELETE FROM shares WHERE id = ?", [r.id]);
      return c.json({ ok: true });
    });
  },
};
