import type { HdContext } from "./context";
import { forbidden, unauthorized } from "./errors";
import { sha256Hex } from "./crypto";
import { getCookie } from "hono/cookie";

export interface AclRule {
  storageId?: number | null;
  mountId?: number | null;
  pathPrefix: string;
  perms: string[];
}

export type Principal =
  | { kind: "admin"; id: number; username: string }
  | { kind: "apikey"; id: number; name: string; permissions: string[]; acl: AclRule[] }
  | { kind: "anon" };

export const SESSION_COOKIE = "hd_session";

export function principalId(p: Principal): string {
  return p.kind === "anon" ? "anon" : `${p.kind}:${p.id}`;
}

/** 解析請求身分：管理員 session → 模組提供的驗證（如 API 金鑰）→ 匿名 */
export async function resolvePrincipal(c: HdContext): Promise<Principal> {
  const ctx = c.get("ctx");
  const auth = c.req.header("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : getCookie(c, SESSION_COOKIE);
  if (token && /^[0-9a-f]{64}$/.test(token)) {
    const row = await ctx.db.first<{ admin_id: number; username: string; expires_at: number }>(
      "SELECT s.admin_id, s.expires_at, a.username FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?",
      [await sha256Hex(token)],
    );
    if (row && row.expires_at > Date.now()) return { kind: "admin", id: row.admin_id, username: row.username };
  }
  for (const m of ctx.modules) {
    if (!m.authenticate) continue;
    const p = await m.authenticate(c);
    if (p) return p;
  }
  return { kind: "anon" };
}

export function requireAdmin(c: HdContext) {
  const p = c.get("principal");
  if (p.kind !== "admin") throw p.kind === "anon" ? unauthorized() : forbidden();
  return p;
}

/**
 * 權限判斷（API 金鑰 ACL 的共用規則）。
 * perm：upload / share / paste / fs.read / fs.write / fs.delete / webdav …
 * scope：限定儲存或掛載與路徑時傳入
 */
export function can(p: Principal, perm: string, scope?: { storageId?: number; mountId?: number; path?: string }): boolean {
  if (p.kind === "admin") return true;
  if (p.kind === "anon") return false;
  if (!p.permissions.includes(perm)) return false;
  if (!scope || p.acl.length === 0) return true;
  const path = scope.path ?? "/";
  return p.acl.some(
    (r) =>
      (r.storageId == null || r.storageId === scope.storageId) &&
      (r.mountId == null || r.mountId === scope.mountId) &&
      (path === r.pathPrefix || path.startsWith(r.pathPrefix.replace(/\/?$/, "/"))) &&
      (r.perms.includes(perm.split(".").pop()!) || r.perms.includes("*")),
  );
}
