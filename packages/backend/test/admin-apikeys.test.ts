import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers/app";
import { can, normalizeAclPath } from "../src/core/auth";
import { verifyApiKey } from "../src/modules/apikeys/service";

describe("can() 硬化", () => {
  const key = (acl: any[], permissions = ["fs.read", "fs.write", "fs.list", "upload"]) => ({ kind: "apikey" as const, id: 1, name: "k", permissions, acl });
  it("路徑正規化與穿越防護", () => {
    expect(normalizeAclPath("//pub///a/")).toBe("/pub/a");
    expect(normalizeAclPath("pub")).toBe("/pub");
    expect(normalizeAclPath("/pub/../x")).toBeNull();
    expect(normalizeAclPath("/pub/./x")).toBeNull();
    expect(normalizeAclPath("/pub/%2e%2e/x")).toBeNull();
    expect(normalizeAclPath("/pub/%252e%252e/x")).toBeNull();
    expect(normalizeAclPath("/pub\\..\\x")).toBeNull();
    expect(normalizeAclPath("/pub/a\u0000")).toBeNull();
  });
  it("前綴以路徑片段為界、擋 ../", () => {
    const k = key([{ storageId: 2, pathPrefix: "/pub", perms: ["read"] }]);
    expect(can(k, "fs.read", { storageId: 2, path: "/pub" })).toBe(true);
    expect(can(k, "fs.read", { storageId: 2, path: "/pub/a/b" })).toBe(true);
    expect(can(k, "fs.read", { storageId: 2, path: "/public" })).toBe(false);
    expect(can(k, "fs.read", { storageId: 2, path: "/pub/../secret" })).toBe(false);
    expect(can(k, "fs.read", { storageId: 2, path: "/pub/%2e%2e/secret" })).toBe(false);
    expect(can(k, "fs.list", { storageId: 2, path: "/pub" })).toBe(true); // read 隱含 list
    expect(can(k, "fs.write", { storageId: 2, path: "/pub/a" })).toBe(false);
    expect(can(k, "upload", { storageId: 2, path: "/pub/a" })).toBe(false); // upload → write
  });
  it("規則前綴含 .. 時該規則無效；掛載規則；*", () => {
    expect(can(key([{ pathPrefix: "/a/..", perms: ["*"] }]), "fs.read", { path: "/x" })).toBe(false);
    const k = key([{ mountId: 5, pathPrefix: "/", perms: ["*"] }]);
    expect(can(k, "fs.write", { mountId: 5, path: "/any" })).toBe(true);
    expect(can(k, "fs.write", { mountId: 6, path: "/any" })).toBe(false);
    expect(can(k, "fs.delete", { mountId: 5, path: "/any" })).toBe(false); // 全域權限沒有 fs.delete
  });
  it("無 ACL 時只看全域權限，但仍擋穿越路徑", () => {
    const k = key([]);
    expect(can(k, "fs.read", { path: "/whatever" })).toBe(true);
    expect(can(k, "fs.read", { path: "/a/../../etc" })).toBe(false);
    expect(can(k, "fs.read")).toBe(true);
    expect(can(k, "paste")).toBe(false);
  });
});

describe("API 金鑰模組", () => {
  async function setup() {
    const h = await makeApp();
    const auth = { authorization: `Bearer ${await h.login()}` };
    return { ...h, auth };
  }
  it("建立只回傳一次明文、只存雜湊；可用 X-API-Key 與 Bearer 驗證", async () => {
    const h = await setup();
    const r = await h.call("POST", "/api/admin/api-keys", { name: "CI", permissions: ["upload", "fs.read"] }, h.auth);
    expect(r.status).toBe(201);
    expect(r.json.key).toMatch(/^hd_[0-9a-f]{32}$/);
    expect(r.json.prefix).toBe(r.json.key.slice(0, 9));
    const row = await h.ctx.db.first<any>("SELECT * FROM api_keys");
    expect(JSON.stringify(row)).not.toContain(r.json.key);
    const list = await h.call("GET", "/api/admin/api-keys", undefined, h.auth);
    expect(JSON.stringify(list.json)).not.toContain(r.json.key);
    expect(list.json.items[0].permissions).toEqual(["upload", "fs.read"]);

    const me1 = await h.call("GET", "/api/auth/me", undefined, { "x-api-key": r.json.key });
    expect(me1.json).toEqual({ kind: "apikey", username: "CI" });
    const me2 = await h.call("GET", "/api/auth/me", undefined, { authorization: `Bearer ${r.json.key}` });
    expect(me2.json.kind).toBe("apikey");
    expect((await h.ctx.db.first<any>("SELECT last_used_at FROM api_keys"))!.last_used_at).toBeGreaterThan(0);
    // 金鑰不能管理金鑰
    expect((await h.call("GET", "/api/admin/api-keys", undefined, { "x-api-key": r.json.key })).status).toBe(403);
    // 無效金鑰 401
    const bad = await h.call("GET", "/api/auth/me", undefined, { "x-api-key": "hd_" + "0".repeat(32) });
    expect(bad.status).toBe(401);
    expect(bad.json.error.code).toBe("invalid_api_key");
  });
  it("停用、到期、刪除後失效；ACL 設定與驗證", async () => {
    const h = await setup();
    const r = await h.call("POST", "/api/admin/api-keys", { name: "k", permissions: ["fs.read"] }, h.auth);
    const id = r.json.id;
    expect((await h.call("PUT", `/api/admin/api-keys/${id}/acl`, [{ storageId: 999 }], h.auth)).status).toBe(400);
    const now = Date.now();
    await h.ctx.db.run("INSERT INTO storages (id, name, type, created_at, updated_at) VALUES (1, 's', 'memory', ?, ?)", [now, now]);
    const acl = await h.call("PUT", `/api/admin/api-keys/${id}/acl`, [{ storageId: 1, pathPrefix: "/pub/", perms: ["read"] }], h.auth);
    expect(acl.status).toBe(200);
    expect(acl.json.acl).toEqual([{ storageId: 1, mountId: null, pathPrefix: "/pub", perms: ["read"] }]);
    const p = await verifyApiKey(h.ctx, r.json.key);
    expect(p && can(p, "fs.read", { storageId: 1, path: "/pub/x" })).toBe(true);
    expect(p && can(p, "fs.read", { storageId: 1, path: "/pub/../x" })).toBe(false);

    expect((await h.call("PUT", `/api/admin/api-keys/${id}/acl`, [{ pathPrefix: "/a/../b" }], h.auth)).status).toBe(400);
    expect((await h.call("PUT", `/api/admin/api-keys/${id}/acl`, [{ storageId: 1, mountId: 2 }], h.auth)).status).toBe(400);
    expect((await h.call("PUT", `/api/admin/api-keys/${id}/acl`, [{ perms: ["root"] }], h.auth)).status).toBe(400);
    expect((await h.call("POST", "/api/admin/api-keys", { name: "x", permissions: ["Bad Perm"] }, h.auth)).status).toBe(400);

    await h.call("PATCH", `/api/admin/api-keys/${id}`, { enabled: false }, h.auth);
    expect(await verifyApiKey(h.ctx, r.json.key)).toBeNull();
    await h.call("PATCH", `/api/admin/api-keys/${id}`, { enabled: true, expiresAt: Date.now() - 1000 }, h.auth);
    expect(await verifyApiKey(h.ctx, r.json.key)).toBeNull();
    await h.call("PATCH", `/api/admin/api-keys/${id}`, { expiresAt: null, name: "改名" }, h.auth);
    expect((await verifyApiKey(h.ctx, r.json.key))?.name).toBe("改名");
    expect((await h.call("DELETE", `/api/admin/api-keys/${id}`, undefined, h.auth)).status).toBe(200);
    expect(await verifyApiKey(h.ctx, r.json.key)).toBeNull();
    expect((await h.ctx.db.first<any>("SELECT COUNT(*) AS n FROM api_key_acl"))!.n).toBe(0);
    expect((await h.call("DELETE", `/api/admin/api-keys/${id}`, undefined, h.auth)).status).toBe(404);
  });
});
