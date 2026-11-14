import type { AppContext, HdContext } from "../../core/context";
import { normalizeAclPath, type AclRule, type Principal } from "../../core/auth";
import { randomToken, sha256Hex } from "../../core/crypto";
import { badRequest, notFound, unauthorized } from "../../core/errors";

/** 金鑰格式：hd_ + 32 個小寫十六進位字元。資料庫只存 SHA-256 */
export const API_KEY_RE = /^hd_[0-9a-f]{32}$/;
/** 權限名稱格式（其他模組可自訂新權限，例如 search） */
const PERM_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const ACL_PERMS = new Set(["read", "list", "write", "delete", "*"]);

export interface ApiKeyRow {
  id: number;
  name: string;
  key_prefix: string;
  key_hash: string;
  permissions: string;
  enabled: number;
  expires_at: number | null;
  last_used_at: number | null;
  created_at: number;
}
interface AclRow {
  id: number;
  api_key_id: number;
  storage_id: number | null;
  mount_id: number | null;
  path_prefix: string;
  perms: string;
}

export interface ApiKeyDto {
  id: number;
  name: string;
  prefix: string;
  permissions: string[];
  enabled: boolean;
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  acl: AclRule[];
}

function parseJsonArray(s: string | null | undefined): string[] {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function generateApiKey(): string {
  return `hd_${randomToken(16)}`;
}

/** 從請求取出金鑰：X-API-Key，或 Authorization: Bearer hd_… */
export function extractApiKey(c: HdContext): string | null {
  const h = c.req.header("x-api-key")?.trim();
  if (h) return h;
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    const t = auth.slice(7).trim();
    if (t.startsWith("hd_")) return t;
  }
  return null;
}

async function loadAcl(ctx: AppContext, keyId: number): Promise<AclRule[]> {
  const rows = await ctx.db.all<AclRow>("SELECT * FROM api_key_acl WHERE api_key_id = ? ORDER BY id", [keyId]);
  return rows.map(aclToRule);
}
function aclToRule(r: AclRow): AclRule {
  return { storageId: r.storage_id, mountId: r.mount_id, pathPrefix: r.path_prefix, perms: parseJsonArray(r.perms) };
}

/** 驗證金鑰；有效則回傳 apikey 身分並更新 last_used_at，否則 null */
export async function verifyApiKey(ctx: AppContext, key: string | null | undefined): Promise<Extract<Principal, { kind: "apikey" }> | null> {
  if (!key || !API_KEY_RE.test(key)) return null;
  const row = await ctx.db.first<ApiKeyRow>("SELECT * FROM api_keys WHERE key_hash = ?", [await sha256Hex(key)]);
  const now = Date.now();
  if (!row || !row.enabled) return null;
  if (row.expires_at != null && row.expires_at <= now) return null;
  // 每分鐘最多寫一次，避免每個請求都寫入
  if (!row.last_used_at || now - row.last_used_at > 60_000) {
    await ctx.db.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", [now, row.id]);
  }
  return { kind: "apikey", id: row.id, name: row.name, permissions: parseJsonArray(row.permissions), acl: await loadAcl(ctx, row.id) };
}

/**
 * HdModule.authenticate：有帶金鑰才處理。金鑰無效時直接回 401（避免被當成匿名而得到令人困惑的結果）。
 */
export async function authenticate(c: HdContext): Promise<Principal | null> {
  const key = extractApiKey(c);
  if (!key) return null;
  const p = await verifyApiKey(c.get("ctx"), key);
  if (!p) throw unauthorized("API 金鑰無效、已停用或已過期", "invalid_api_key");
  return p;
}

// ───────── 管理 ─────────

export function validatePermissions(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw badRequest("permissions 必須是字串陣列");
  const out = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
  for (const p of out) if (!PERM_RE.test(p)) throw badRequest(`權限名稱不合法：${p}`);
  return out;
}

function validateExpires(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw badRequest("到期時間格式錯誤（Unix 毫秒）");
  return Math.floor(n);
}

export function validateAcl(v: unknown): AclRule[] {
  const list = Array.isArray(v) ? v : (v as { rules?: unknown })?.rules;
  if (!Array.isArray(list)) throw badRequest("ACL 必須是規則陣列");
  if (list.length > 200) throw badRequest("ACL 規則過多（上限 200）");
  return list.map((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const storageId = r.storageId == null || r.storageId === "" ? null : Number(r.storageId);
    const mountId = r.mountId == null || r.mountId === "" ? null : Number(r.mountId);
    if (storageId != null && !Number.isInteger(storageId)) throw badRequest(`第 ${i + 1} 條規則的儲存 ID 錯誤`);
    if (mountId != null && !Number.isInteger(mountId)) throw badRequest(`第 ${i + 1} 條規則的掛載 ID 錯誤`);
    if (storageId != null && mountId != null) throw badRequest(`第 ${i + 1} 條規則：儲存與掛載只能擇一`);
    const pathPrefix = normalizeAclPath(typeof r.pathPrefix === "string" ? r.pathPrefix : "/");
    if (pathPrefix === null) throw badRequest(`第 ${i + 1} 條規則的路徑不合法（不可含 .. 或反斜線）`);
    const perms = Array.isArray(r.perms) ? [...new Set(r.perms.map(String))] : ["read"];
    if (perms.length === 0) throw badRequest(`第 ${i + 1} 條規則至少需要一個動作`);
    for (const p of perms) if (!ACL_PERMS.has(p)) throw badRequest(`第 ${i + 1} 條規則的動作不合法：${p}（可用 read / list / write / delete / *）`);
    return { storageId, mountId, pathPrefix, perms };
  });
}

async function toDto(ctx: AppContext, r: ApiKeyRow): Promise<ApiKeyDto> {
  return {
    id: r.id,
    name: r.name,
    prefix: r.key_prefix,
    permissions: parseJsonArray(r.permissions),
    enabled: !!r.enabled,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    acl: await loadAcl(ctx, r.id),
  };
}

export async function listApiKeys(ctx: AppContext): Promise<ApiKeyDto[]> {
  const rows = await ctx.db.all<ApiKeyRow>("SELECT * FROM api_keys ORDER BY id DESC");
  const acl = await ctx.db.all<AclRow>("SELECT * FROM api_key_acl ORDER BY id");
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.key_prefix,
    permissions: parseJsonArray(r.permissions),
    enabled: !!r.enabled,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    acl: acl.filter((a) => a.api_key_id === r.id).map(aclToRule),
  }));
}

export async function getApiKey(ctx: AppContext, id: number): Promise<ApiKeyDto> {
  const row = await ctx.db.first<ApiKeyRow>("SELECT * FROM api_keys WHERE id = ?", [id]);
  if (!row) throw notFound("找不到 API 金鑰");
  return toDto(ctx, row);
}

/** 建立金鑰；明文只在回傳值出現這一次 */
export async function createApiKey(
  ctx: AppContext,
  input: { name?: unknown; permissions?: unknown; expiresAt?: unknown; acl?: unknown; enabled?: unknown },
): Promise<ApiKeyDto & { key: string }> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw badRequest("請輸入名稱");
  if (name.length > 100) throw badRequest("名稱過長（上限 100 字）");
  const permissions = validatePermissions(input.permissions);
  const expiresAt = validateExpires(input.expiresAt);
  const acl = input.acl === undefined ? [] : validateAcl(input.acl);
  await checkAclRefs(ctx, acl);
  const key = generateApiKey();
  const now = Date.now();
  const res = await ctx.db.run(
    "INSERT INTO api_keys (name, key_prefix, key_hash, permissions, enabled, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [name, key.slice(0, 9), await sha256Hex(key), JSON.stringify(permissions), input.enabled === false ? 0 : 1, expiresAt, now],
  );
  if (acl.length) await replaceAcl(ctx, res.lastRowId, acl);
  return { ...(await getApiKey(ctx, res.lastRowId)), key };
}

export async function updateApiKey(
  ctx: AppContext,
  id: number,
  input: { name?: unknown; permissions?: unknown; expiresAt?: unknown; enabled?: unknown },
): Promise<ApiKeyDto> {
  await getApiKey(ctx, id);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw badRequest("請輸入名稱");
    if (name.length > 100) throw badRequest("名稱過長（上限 100 字）");
    sets.push("name = ?");
    params.push(name);
  }
  if (input.permissions !== undefined) {
    sets.push("permissions = ?");
    params.push(JSON.stringify(validatePermissions(input.permissions)));
  }
  if (input.expiresAt !== undefined) {
    sets.push("expires_at = ?");
    params.push(validateExpires(input.expiresAt));
  }
  if (input.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(input.enabled ? 1 : 0);
  }
  if (sets.length) await ctx.db.run(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
  return getApiKey(ctx, id);
}

export async function deleteApiKey(ctx: AppContext, id: number): Promise<void> {
  // 不依賴 SQLite foreign_keys 設定，手動刪除 ACL
  await ctx.db.batch([
    { sql: "DELETE FROM api_key_acl WHERE api_key_id = ?", params: [id] },
    { sql: "DELETE FROM api_keys WHERE id = ?", params: [id] },
  ]);
}

/** 確認規則引用的儲存／掛載存在（避免外鍵錯誤變成 500） */
export async function checkAclRefs(ctx: AppContext, rules: AclRule[]): Promise<void> {
  for (const [i, r] of rules.entries()) {
    if (r.storageId != null && !(await ctx.db.first("SELECT id FROM storages WHERE id = ?", [r.storageId])))
      throw badRequest(`第 ${i + 1} 條規則的儲存不存在`);
    if (r.mountId != null && !(await ctx.db.first("SELECT id FROM mounts WHERE id = ?", [r.mountId])))
      throw badRequest(`第 ${i + 1} 條規則的掛載不存在`);
  }
}

export async function replaceAcl(ctx: AppContext, id: number, rules: AclRule[]): Promise<void> {
  await checkAclRefs(ctx, rules);
  await ctx.db.batch([
    { sql: "DELETE FROM api_key_acl WHERE api_key_id = ?", params: [id] },
    ...rules.map((r) => ({
      sql: "INSERT INTO api_key_acl (api_key_id, storage_id, mount_id, path_prefix, perms) VALUES (?, ?, ?, ?, ?)",
      params: [id, r.storageId ?? null, r.mountId ?? null, r.pathPrefix, JSON.stringify(r.perms)],
    })),
  ]);
}
