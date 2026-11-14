import type { AppContext } from "../../core/context";
import { hashPassword, randomId } from "../../core/crypto";
import { badRequest, conflict } from "../../core/errors";
import type { PasteAdminItem, PasteCreateInput, PasteInfo } from "@harbordrop/shared";

/** 文字分享服務；計次／到期／密碼規則與 shares 相同 */

export interface PasteRow {
  id: number;
  slug: string;
  title: string | null;
  content: string;
  format: string;
  size: number;
  password_hash: string | null;
  expires_at: number | null;
  max_views: number | null;
  views: number;
  remark: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

const SLUG_RE = /^[A-Za-z0-9_-]{3,64}$/;
const RESERVED = new Set(["api", "admin", "upload", "login", "assets", "dav", "fs", "new", "raw"]);
const FORMAT_RE = /^(markdown|text|code(:[a-z0-9+#_.-]{1,32})?)$/;

export const byteLength = (s: string) => new TextEncoder().encode(s).byteLength;

export function normalizeFormat(f: unknown): string {
  if (f == null || f === "") return "markdown";
  const s = String(f).toLowerCase();
  if (!FORMAT_RE.test(s)) throw badRequest("格式只能是 markdown、text 或 code:<語言>", "invalid_format");
  return s;
}

export async function assertContent(ctx: AppContext, content: unknown): Promise<string> {
  if (typeof content !== "string" || content.length === 0) throw badRequest("內容不可為空", "empty_content");
  const max = Number(await ctx.settings.get("pasteMaxBytes")) || 0;
  if (max && byteLength(content) > max) throw badRequest(`內容超過上限（${max} 位元組）`, "paste_too_large");
  return content;
}

export async function createPaste(ctx: AppContext, input: PasteCreateInput, opts: { anonymous: boolean; createdBy: string }): Promise<PasteRow> {
  const content = await assertContent(ctx, input?.content);
  const format = normalizeFormat(input.format);
  const title = input.title ? String(input.title).slice(0, 200) : null;
  if (input.slug) {
    if (!SLUG_RE.test(input.slug) || RESERVED.has(input.slug.toLowerCase())) throw badRequest("自訂連結只能使用英數字、- 和 _，長度 3–64", "invalid_slug");
    if (await ctx.db.first("SELECT 1 FROM pastes WHERE slug = ?", [input.slug])) throw conflict("此自訂連結已被使用", "slug_taken");
  }
  const passwordHash = input.password ? await hashPassword(String(input.password)) : null;
  let hours = Number(input.expiresInHours) || 0;
  if (opts.anonymous) {
    const maxH = Number(await ctx.settings.get("anonymousMaxExpiryHours")) || 0;
    if (maxH && (!hours || hours > maxH)) hours = maxH;
  }
  const expiresAt = hours > 0 ? Date.now() + hours * 3600_000 : null;
  const mv = Number(input.maxViews) || 0;
  const maxViews = mv > 0 ? Math.floor(mv) : null;
  const remark = input.remark ? String(input.remark).slice(0, 500) : null;
  const now = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = input.slug ?? randomId(8);
    try {
      const r = await ctx.db.run(
        "INSERT INTO pastes (slug, title, content, format, size, password_hash, expires_at, max_views, remark, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [slug, title, content, format, byteLength(content), passwordHash, expiresAt, maxViews, remark, opts.createdBy, now, now],
      );
      return (await ctx.db.first<PasteRow>("SELECT * FROM pastes WHERE id = ?", [r.lastRowId]))!;
    } catch (e: any) {
      if (!/UNIQUE/i.test(String(e?.message))) throw e;
      if (input.slug) throw conflict("此自訂連結已被使用", "slug_taken");
    }
  }
  throw conflict("無法產生唯一連結，請重試");
}

export function pasteStatus(r: Pick<PasteRow, "expires_at" | "max_views" | "views">): "ok" | "expired" | "exhausted" {
  if (r.expires_at && r.expires_at < Date.now()) return "expired";
  if (r.max_views != null && r.views >= r.max_views) return "exhausted";
  return "ok";
}

export function pasteInfo(r: PasteRow, withContent = false): PasteInfo {
  const o: PasteInfo = {
    slug: r.slug,
    title: r.title,
    format: r.format,
    size: r.size,
    expiresAt: r.expires_at,
    maxViews: r.max_views,
    views: r.views,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    passwordRequired: !!r.password_hash,
  };
  if (withContent) o.content = r.content;
  return o;
}

export function pasteAdminItem(r: PasteRow): PasteAdminItem {
  return { ...pasteInfo(r), id: r.id, remark: r.remark, createdBy: r.created_by, excerpt: r.content.slice(0, 200) };
}

/** 原子計次；超過上限時回傳 false（不更新） */
export async function countView(ctx: AppContext, id: number): Promise<boolean> {
  const u = await ctx.db.run("UPDATE pastes SET views = views + 1 WHERE id = ? AND (max_views IS NULL OR views < max_views)", [id]);
  return u.changes > 0;
}

/** 刪除已過期或次數用完的 paste，回傳刪除筆數（供 jobs 的 cleanup.expired 使用） */
export async function deleteExpiredPastes(ctx: AppContext, now = Date.now()): Promise<number> {
  const r = await ctx.db.run("DELETE FROM pastes WHERE (expires_at IS NOT NULL AND expires_at < ?) OR (max_views IS NOT NULL AND views >= max_views)", [now]);
  return r.changes;
}
