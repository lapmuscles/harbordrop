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

/** 全域權限 → ACL 規則中的動作（read / list / write / delete）。未列者取最後一段（fs.read → read） */
const PERM_TO_ACL: Record<string, string> = {
  "fs.read": "read",
  "fs.list": "list",
  "fs.write": "write",
  "fs.delete": "delete",
  upload: "write",
  share: "read",
  paste: "write",
  webdav: "read",
};
export function aclActionFor(perm: string): string {
  return PERM_TO_ACL[perm] ?? perm.split(".").pop()!;
}

/**
 * 正規化 ACL／請求路徑：統一以 "/" 開頭、去除重複與結尾的 "/"。
 * 含 `..`、`.` 片段、反斜線、NUL 或控制字元（含 URL 編碼後）時回傳 null（一律拒絕，不嘗試解析）。
 */
export function normalizeAclPath(input: string | null | undefined): string | null {
  if (input == null) return "/";
  let s = String(input);
  // 擋下編碼過的穿越（%2e%2e、%2f、%5c 等）：解碼一次後再檢查；解碼失敗視為不合法
  if (s.includes("%")) {
    try {
      s = decodeURIComponent(s);
    } catch {
      return null;
    }
    if (s.includes("%")) return null; // 雙重編碼
  }
  if (/[\\\x00-\x1f\x7f]/.test(s)) return null;
  const segs = s.split("/").filter((x) => x !== "");
  if (segs.some((x) => x === "." || x === ".." || /^\.+$/.test(x.trim()))) return null;
  return "/" + segs.join("/");
}

/** prefix 是否涵蓋 path（以路徑片段為界：/pub 涵蓋 /pub 與 /pub/a，但不涵蓋 /public） */
export function pathWithin(path: string, prefix: string): boolean {
  if (prefix === "/") return true;
  return path === prefix || path.startsWith(prefix + "/");
}

/**
 * 權限判斷（API 金鑰 ACL 的共用規則）。
 * perm：upload / share / paste / fs.read / fs.list / fs.write / fs.delete / webdav …
 * scope：限定儲存或掛載與路徑時傳入。
 * 規則：
 *  1. 管理員一律允許；匿名一律拒絕（匿名功能由各模組依設定自行判斷）。
 *  2. 金鑰的全域 permissions 必須包含 perm。
 *  3. 未傳 scope 或金鑰沒有任何 ACL → 只看全域權限。
 *  4. 有 ACL 時，至少一條規則需同時符合：儲存／掛載（規則未指定則不限）、路徑前綴（以片段為界）、動作
 *     （規則 perms 含對應動作或 "*"；read 隱含 list）。
 *  5. 路徑含 `..` 等穿越片段、反斜線或控制字元時一律拒絕。
 */
export function can(p: Principal, perm: string, scope?: { storageId?: number; mountId?: number; path?: string }): boolean {
  if (p.kind === "admin") return true;
  if (p.kind !== "apikey") return false;
  if (!Array.isArray(p.permissions) || !p.permissions.includes(perm)) return false;
  if (!scope) return true;
  const path = normalizeAclPath(scope.path ?? "/");
  if (path === null) return false;
  if (!Array.isArray(p.acl) || p.acl.length === 0) return true;
  const action = aclActionFor(perm);
  return p.acl.some((r) => {
    if (r.storageId != null && r.storageId !== scope.storageId) return false;
    if (r.mountId != null && r.mountId !== scope.mountId) return false;
    const prefix = normalizeAclPath(r.pathPrefix ?? "/");
    if (prefix === null || !pathWithin(path, prefix)) return false;
    const perms = Array.isArray(r.perms) ? r.perms : [];
    return perms.includes("*") || perms.includes(action) || (action === "list" && perms.includes("read"));
  });
}
