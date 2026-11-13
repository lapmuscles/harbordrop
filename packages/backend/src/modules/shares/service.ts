import type { AppContext } from "../../core/context";
import { hashPassword, randomId } from "../../core/crypto";
import { badRequest, conflict } from "../../core/errors";
import { previewKind, type ShareInfo, type ShareOptionsInput } from "@harbordrop/shared";

/** 分享服務（其他模組可 import 本檔，例如檔案瀏覽器的「建立分享」） */

export interface ShareRow {
  id: number;
  slug: string;
  storage_id: number | null;
  object_path: string;
  filename: string;
  size: number;
  mime: string | null;
  sha256: string | null;
  password_hash: string | null;
  expires_at: number | null;
  max_views: number | null;
  views: number;
  remark: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

/** 已驗證、密碼已雜湊、可直接寫入的分享參數 */
export interface PreparedShareOptions {
  slug?: string;
  passwordHash?: string | null;
  expiresAt?: number | null;
  maxViews?: number | null;
  remark?: string | null;
}

const SLUG_RE = /^[A-Za-z0-9_-]{3,64}$/;
const RESERVED = new Set(["api", "admin", "upload", "login", "assets", "dav", "fs"]);

export async function prepareShareOptions(
  ctx: AppContext,
  input: ShareOptionsInput | undefined,
  opts: { anonymous: boolean },
): Promise<PreparedShareOptions> {
  const o = input ?? {};
  const out: PreparedShareOptions = {};
  if (o.slug) {
    if (!SLUG_RE.test(o.slug) || RESERVED.has(o.slug.toLowerCase())) throw badRequest("自訂連結只能使用英數字、- 和 _，長度 3–64", "invalid_slug");
    if (await ctx.db.first("SELECT 1 FROM shares WHERE slug = ?", [o.slug])) throw conflict("此自訂連結已被使用", "slug_taken");
    out.slug = o.slug;
  }
  if (o.password) out.passwordHash = await hashPassword(o.password);
  let hours = Number(o.expiresInHours) || 0;
  if (opts.anonymous) {
    const maxH = Number(await ctx.settings.get("anonymousMaxExpiryHours")) || 0;
    if (maxH && (!hours || hours > maxH)) hours = maxH;
  }
  out.expiresAt = hours > 0 ? Date.now() + hours * 3600_000 : null;
  const mv = Number(o.maxViews) || 0;
  out.maxViews = mv > 0 ? Math.floor(mv) : null;
  out.remark = o.remark?.slice(0, 500) ?? null;
  return out;
}

export async function createShare(
  ctx: AppContext,
  file: { storageId: number; objectPath: string; filename: string; size: number; mime?: string | null; sha256?: string | null },
  o: PreparedShareOptions,
  createdBy: string,
): Promise<ShareRow> {
  const now = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = o.slug ?? randomId(8);
    try {
      const r = await ctx.db.run(
        "INSERT INTO shares (slug, storage_id, object_path, filename, size, mime, sha256, password_hash, expires_at, max_views, remark, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [slug, file.storageId, file.objectPath, file.filename, file.size, file.mime ?? null, file.sha256 ?? null, o.passwordHash ?? null, o.expiresAt ?? null, o.maxViews ?? null, o.remark ?? null, createdBy, now, now],
      );
      return (await ctx.db.first<ShareRow>("SELECT * FROM shares WHERE id = ?", [r.lastRowId]))!;
    } catch (e: any) {
      if (!/UNIQUE/i.test(String(e?.message))) throw e;
      if (o.slug) throw conflict("此自訂連結已被使用", "slug_taken");
    }
  }
  throw conflict("無法產生唯一連結，請重試");
}

export function shareInfo(r: ShareRow): ShareInfo {
  return {
    slug: r.slug,
    filename: r.filename,
    size: r.size,
    mime: r.mime,
    sha256: r.sha256,
    expiresAt: r.expires_at,
    maxViews: r.max_views,
    views: r.views,
    createdAt: r.created_at,
    passwordRequired: !!r.password_hash,
    previewKind: previewKind(r.filename, r.mime),
  };
}

/** 回傳分享狀態：可用 / 過期 / 次數用完 */
export function shareStatus(r: ShareRow): "ok" | "expired" | "exhausted" {
  if (r.expires_at && r.expires_at < Date.now()) return "expired";
  if (r.max_views != null && r.views >= r.max_views) return "exhausted";
  return "ok";
}
