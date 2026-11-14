import { anonClientIp, hitAnonLimit } from "../../core/anonlimit";
import type { HdModule } from "../types";
import type { HdContext } from "../../core/context";
import { can, principalId, requireAdmin } from "../../core/auth";
import { hashPassword, verifyPassword } from "../../core/crypto";
import { badRequest, forbidden, gone, notFound, unauthorized } from "../../core/errors";
import { signToken, verifyToken } from "../../core/sign";
import type { PasteCreateInput } from "@harbordrop/shared";
import {
  type PasteRow,
  assertContent,
  byteLength,
  countView,
  createPaste,
  deleteExpiredPastes,
  normalizeFormat,
  pasteAdminItem,
  pasteInfo,
  pasteStatus,
} from "./service";

/**
 * 文字分享（規格：docs/MODULES-zhTW.md#pastes）
 *   POST /api/pastes                   建立（管理員／API 金鑰 paste 權限／設定 allowAnonymousPaste 時匿名）
 *   GET  /api/pastes/:slug             資訊＋內容（已解鎖時計一次瀏覽；?meta=1 只回資訊、不計次）
 *   POST /api/pastes/:slug/unlock      密碼解鎖 → 短效 token（?t= 或 x-paste-token）
 *   GET  /api/pastes/:slug/raw         純文字內容（計一次瀏覽）
 *   GET/PATCH/DELETE /api/admin/pastes[/:slug]  管理
 */

const UNLOCK_TTL = 6 * 3600;

async function load(c: HdContext): Promise<PasteRow> {
  const r = await c.get("ctx").db.first<PasteRow>("SELECT * FROM pastes WHERE slug = ?", [c.req.param("slug")]);
  if (!r) throw notFound("文字分享不存在或已刪除");
  return r;
}

function assertAvailable(r: PasteRow) {
  const s = pasteStatus(r);
  if (s === "expired") throw gone("文字分享已過期", "paste_expired");
  if (s === "exhausted") throw gone("文字分享已達瀏覽次數上限", "paste_exhausted");
}

const tokenSubject = (r: PasteRow) => `paste:${r.slug}:${r.password_hash!.slice(-12)}`;

async function unlocked(c: HdContext, r: PasteRow): Promise<boolean> {
  if (!r.password_hash) return true;
  const t = c.req.query("t") ?? c.req.header("x-paste-token");
  return verifyToken(c.get("ctx").env.APP_SECRET!, tokenSubject(r), t);
}

/** 計一次並回傳最新列；次數已用完則 410 */
async function consume(c: HdContext, r: PasteRow): Promise<PasteRow> {
  if (!(await countView(c.get("ctx"), r.id))) throw gone("文字分享已達瀏覽次數上限", "paste_exhausted");
  return { ...r, views: r.views + 1 };
}

export const pastesModule: HdModule = {
  name: "pastes",
  settings: [
    { key: "allowAnonymousPaste", default: false, public: true, label: "允許匿名建立文字分享" },
    { key: "pasteMaxBytes", default: 1024 * 1024, public: true, label: "文字分享內容上限（位元組，0 = 不限）" },
  ],
  jobs: {
    "pastes.cleanup": async (ctx) => `已刪除 ${await deleteExpiredPastes(ctx)} 筆過期文字分享`,
  },
  routes(app) {
    app.post("/api/pastes", async (c) => {
      const ctx = c.get("ctx");
      const p = c.get("principal");
      const anonymous = p.kind === "anon";
      if (anonymous) {
        if (!(await ctx.settings.get("allowAnonymousPaste"))) throw unauthorized("未開放匿名建立文字分享，請先登入", "anonymous_paste_disabled");
        await hitAnonLimit(ctx, "paste", anonClientIp(c));
      } else if (!can(p, "paste")) throw forbidden("此 API 金鑰沒有 paste 權限");
      const body = await c.req.json<PasteCreateInput>().catch(() => null);
      if (!body || typeof body !== "object") throw badRequest("請求格式錯誤");
      const r = await createPaste(ctx, body, { anonymous, createdBy: principalId(p) });
      return c.json({ paste: pasteInfo(r), url: `/p/${r.slug}` }, 201);
    });

    app.get("/api/pastes/:slug", async (c) => {
      let r = await load(c);
      assertAvailable(r);
      if (c.req.query("meta") === "1" || !(await unlocked(c, r))) return c.json(pasteInfo(r));
      r = await consume(c, r);
      return c.json(pasteInfo(r, true));
    });

    app.post("/api/pastes/:slug/unlock", async (c) => {
      const ctx = c.get("ctx");
      const r = await load(c);
      assertAvailable(r);
      const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
      if (!r.password_hash) return c.json({ token: null });
      if (!password || !(await verifyPassword(password, r.password_hash))) throw unauthorized("密碼錯誤", "wrong_password");
      return c.json({ token: await signToken(ctx.env.APP_SECRET!, tokenSubject(r), UNLOCK_TTL) });
    });

    app.get("/api/pastes/:slug/raw", async (c) => {
      const r = await load(c);
      assertAvailable(r);
      if (!(await unlocked(c, r))) throw unauthorized("需要密碼", "password_required");
      await consume(c, r);
      return new Response(r.content, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
          ...(c.req.query("download") === "1" ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent((r.title || r.slug) + ".txt")}` } : {}),
        },
      });
    });

    app.get("/api/admin/pastes", async (c) => {
      requireAdmin(c);
      const db = c.get("ctx").db;
      const limit = Math.min(200, Number(c.req.query("limit")) || 50);
      const offset = Number(c.req.query("offset")) || 0;
      const q = c.req.query("q")?.trim();
      const where = q ? "WHERE slug LIKE ? OR title LIKE ? OR remark LIKE ?" : "";
      const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
      const rows = await db.all<PasteRow>(`SELECT * FROM pastes ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
      const total = (await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM pastes ${where}`, args))!.n;
      return c.json({ total, items: rows.map(pasteAdminItem) });
    });

    /** 管理員讀取完整內容（不計次、不受密碼／到期限制） */
    app.get("/api/admin/pastes/:slug", async (c) => {
      requireAdmin(c);
      const r = await load(c);
      return c.json({ ...pasteAdminItem(r), content: r.content, status: pasteStatus(r) });
    });

    app.patch("/api/admin/pastes/:slug", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const r = await load(c);
      const b = await c.req.json<{
        title?: string | null;
        content?: string;
        format?: string;
        password?: string | null;
        expiresAt?: number | null;
        maxViews?: number | null;
        remark?: string | null;
        resetViews?: boolean;
      }>();
      if (b.maxViews != null && b.maxViews < 0) throw badRequest("次數不可為負");
      const content = b.content !== undefined ? await assertContent(ctx, b.content) : r.content;
      const passwordHash = b.password === undefined ? r.password_hash : b.password ? await hashPassword(b.password) : null;
      await ctx.db.run(
        "UPDATE pastes SET title = ?, content = ?, size = ?, format = ?, password_hash = ?, expires_at = ?, max_views = ?, remark = ?, views = ?, updated_at = ? WHERE id = ?",
        [
          b.title !== undefined ? (b.title ? String(b.title).slice(0, 200) : null) : r.title,
          content,
          byteLength(content),
          b.format !== undefined ? normalizeFormat(b.format) : r.format,
          passwordHash,
          b.expiresAt !== undefined ? b.expiresAt : r.expires_at,
          b.maxViews !== undefined ? b.maxViews || null : r.max_views,
          b.remark !== undefined ? b.remark : r.remark,
          b.resetViews ? 0 : r.views,
          Date.now(),
          r.id,
        ],
      );
      return c.json({ ok: true });
    });

    app.delete("/api/admin/pastes/:slug", async (c) => {
      requireAdmin(c);
      const r = await load(c);
      await c.get("ctx").db.run("DELETE FROM pastes WHERE id = ?", [r.id]);
      return c.json({ ok: true });
    });
  },
};
