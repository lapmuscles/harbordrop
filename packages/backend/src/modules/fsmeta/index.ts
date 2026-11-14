import type { HdModule } from "../types";
import type { HdContext } from "../../core/context";
import { requireAdmin } from "../../core/auth";
import { hashPassword, verifyPassword } from "../../core/crypto";
import { badRequest, conflict, forbidden, notFound } from "../../core/errors";
import { normalizePath } from "../../storage/util";
import { assertUnlocked, effectiveMeta, issueUnlockToken, UNLOCK_TTL_SECONDS, type FsMetaRow } from "./service";

/**
 * 目錄 meta：
 *   管理：GET/POST /api/admin/fs-meta、PATCH/DELETE /api/admin/fs-meta/:id
 *   公開：GET /api/fs/meta?path=（生效中的 header/readme/是否需密碼）、POST /api/fs/unlock { path, password }
 */

const dto = (r: FsMetaRow) => ({
  id: r.id,
  path: r.path,
  headerMd: r.header_md,
  readmeMd: r.readme_md,
  hasPassword: !!r.password_hash,
  hidePatterns: JSON.parse(r.hide_patterns || "[]") as string[],
  applyToChildren: !!r.apply_to_children,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

function safePath(p: unknown): string {
  try {
    return normalizePath(String(p ?? ""));
  } catch {
    throw badRequest("路徑不正確");
  }
}

function patterns(v: unknown): string {
  if (v === undefined || v === null) return "[]";
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw badRequest("隱藏規則必須是字串陣列");
  return JSON.stringify(v.map((s: string) => s.trim()).filter(Boolean).slice(0, 200));
}

async function canBrowse(c: HdContext): Promise<boolean> {
  const p = c.get("principal");
  if (p.kind !== "anon") return true;
  return !!(await c.get("ctx").settings.get("fsPublicBrowse"));
}

export const fsmetaModule: HdModule = {
  name: "fsmeta",
  routes(app) {
    app.get("/api/admin/fs-meta", async (c) => {
      requireAdmin(c);
      const rows = await c.get("ctx").db.all<FsMetaRow>("SELECT * FROM fs_meta ORDER BY path");
      return c.json({ items: rows.map(dto) });
    });

    app.post("/api/admin/fs-meta", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const b = await c.req.json<any>();
      const path = safePath(b.path);
      if (await ctx.db.first("SELECT 1 FROM fs_meta WHERE path = ?", [path])) throw conflict("此路徑已有設定");
      const now = Date.now();
      const r = await ctx.db.run(
        "INSERT INTO fs_meta (path, header_md, readme_md, password_hash, hide_patterns, apply_to_children, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [path, b.headerMd || null, b.readmeMd || null, b.password ? await hashPassword(String(b.password)) : null, patterns(b.hidePatterns), b.applyToChildren === false ? 0 : 1, now, now],
      );
      return c.json(dto((await ctx.db.first<FsMetaRow>("SELECT * FROM fs_meta WHERE id = ?", [r.lastRowId]))!), 201);
    });

    app.patch("/api/admin/fs-meta/:id", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const old = await ctx.db.first<FsMetaRow>("SELECT * FROM fs_meta WHERE id = ?", [Number(c.req.param("id"))]);
      if (!old) throw notFound("找不到此設定");
      const b = await c.req.json<any>();
      const path = b.path !== undefined ? safePath(b.path) : old.path;
      if (path !== old.path && (await ctx.db.first("SELECT 1 FROM fs_meta WHERE path = ?", [path]))) throw conflict("此路徑已有設定");
      // password：undefined = 不變；"" 或 null = 移除；其他 = 設定新密碼
      let pw = old.password_hash;
      if (b.password === "" || b.password === null) pw = null;
      else if (typeof b.password === "string") pw = await hashPassword(b.password);
      await ctx.db.run(
        "UPDATE fs_meta SET path = ?, header_md = ?, readme_md = ?, password_hash = ?, hide_patterns = ?, apply_to_children = ?, updated_at = ? WHERE id = ?",
        [
          path,
          b.headerMd !== undefined ? b.headerMd || null : old.header_md,
          b.readmeMd !== undefined ? b.readmeMd || null : old.readme_md,
          pw,
          b.hidePatterns !== undefined ? patterns(b.hidePatterns) : old.hide_patterns,
          b.applyToChildren !== undefined ? (b.applyToChildren ? 1 : 0) : old.apply_to_children,
          Date.now(),
          old.id,
        ],
      );
      return c.json(dto((await ctx.db.first<FsMetaRow>("SELECT * FROM fs_meta WHERE id = ?", [old.id]))!));
    });

    app.delete("/api/admin/fs-meta/:id", async (c) => {
      requireAdmin(c);
      const r = await c.get("ctx").db.run("DELETE FROM fs_meta WHERE id = ?", [Number(c.req.param("id"))]);
      if (!r.changes) throw notFound("找不到此設定");
      return c.json({ ok: true });
    });

    app.get("/api/fs/meta", async (c) => {
      if (!(await canBrowse(c))) throw c.get("principal").kind === "anon" ? forbidden("未開放匿名瀏覽") : forbidden();
      const path = safePath(c.req.query("path") ?? "/");
      const m = await effectiveMeta(c.get("ctx"), path);
      let unlocked = true;
      try {
        await assertUnlocked(c, m);
      } catch {
        unlocked = false;
      }
      return c.json({
        path,
        passwordRequired: !!m.passwordPath,
        passwordPath: m.passwordPath,
        unlocked,
        headerMd: unlocked ? m.headerMd : null,
        readmeMd: unlocked ? m.readmeMd : null,
      });
    });

    app.post("/api/fs/unlock", async (c) => {
      const ctx = c.get("ctx");
      const b = await c.req.json<any>();
      const m = await effectiveMeta(ctx, safePath(b.path));
      if (!m.passwordPath) return c.json({ ok: true, token: null, path: null });
      if (!(await verifyPassword(String(b.password ?? ""), m.passwordHash))) throw forbidden("密碼錯誤", "wrong_password");
      return c.json({ ok: true, path: m.passwordPath, token: await issueUnlockToken(ctx, m.passwordPath), expiresIn: UNLOCK_TTL_SECONDS });
    });
  },
};
