import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers/app";
import { verifyApiKey } from "../src/modules/apikeys/service";

async function setup(env: Record<string, string> = {}) {
  const h = await makeApp(env);
  const auth = { authorization: `Bearer ${await h.login()}` };
  return { ...h, auth };
}

async function seed(h: Awaited<ReturnType<typeof setup>>) {
  const st = await h.call("POST", "/api/admin/storages", { name: "M", type: "memory", config: { label: "x", secretKey: "s3cret" } }, h.auth);
  const now = Date.now();
  await h.ctx.db.run("INSERT INTO mounts (mount_path, storage_id, created_at, updated_at) VALUES ('/m', ?, ?, ?)", [st.json.id, now, now]);
  await h.ctx.db.run("INSERT INTO shares (slug, storage_id, object_path, filename, created_by, created_at, updated_at) VALUES ('abc', ?, '/a', 'a', 'admin:1', ?, ?)", [st.json.id, now, now]);
  await h.ctx.db.run("INSERT INTO pastes (slug, content, created_by, created_at, updated_at) VALUES ('p1', '哈囉', 'admin:1', ?, ?)", [now, now]);
  await h.ctx.db.run("INSERT INTO fs_meta (path, created_at, updated_at) VALUES ('/m', ?, ?)", [now, now]);
  await h.ctx.db.run("INSERT INTO settings (key, value, updated_at) VALUES ('siteName', '\"我的站\"', ?)", [now]);
  const key = await h.call("POST", "/api/admin/api-keys", { name: "k", permissions: ["fs.read"], acl: [{ storageId: st.json.id, pathPrefix: "/pub", perms: ["read"] }] }, h.auth);
  await h.call("POST", "/api/admin/jobs", { kind: "cleanup.expired", name: "清理", intervalSeconds: 3600 }, h.auth);
  return { storageId: st.json.id as number, key: key.json.key as string };
}

describe("備份與還原", () => {
  it("匯出內容：機密仍為密文、金鑰只有雜湊、需管理員", async () => {
    const h = await setup();
    const s = await seed(h);
    expect((await h.call("GET", "/api/admin/backup/export")).status).toBe(401);
    const ex = await h.call("GET", "/api/admin/backup/export", undefined, h.auth);
    expect(ex.status).toBe(200);
    expect(ex.headers.get("content-disposition")).toMatch(/harbordrop-backup-\d{8}\.json/);
    expect(ex.json.format).toBe("harbordrop-backup");
    expect(ex.text).not.toContain("s3cret");
    expect(ex.text).not.toContain(s.key);
    for (const t of ["settings", "storages", "mounts", "shares", "pastes", "fs_meta", "api_keys", "api_key_acl", "scheduled_jobs"])
      expect(ex.json.tables[t].length, t).toBeGreaterThan(0);
  });

  it("replace：還原到新環境（相同 APP_SECRET），機密可解、金鑰可用", async () => {
    const a = await setup();
    const s = await seed(a);
    const backup = (await a.call("GET", "/api/admin/backup/export", undefined, a.auth)).json;
    const b = await setup();
    const r = await b.call("POST", "/api/admin/backup/import", { mode: "replace", data: backup }, b.auth);
    expect(r.status).toBe(200);
    expect(r.json.warnings).toEqual([]);
    expect(r.json.tables.storages.inserted).toBe(1);
    const t = await b.call("POST", `/api/admin/storages/${s.storageId}/test`, undefined, b.auth);
    expect(t.status).toBe(200);
    expect((await b.ctx.db.first<any>("SELECT value FROM settings WHERE key = 'siteName'"))!.value).toBe('"我的站"');
    const p = await verifyApiKey(b.ctx, s.key);
    expect(p?.acl).toEqual([{ storageId: s.storageId, mountId: null, pathPrefix: "/pub", perms: ["read"] }]);
    expect((await b.ctx.db.first<any>("SELECT COUNT(*) AS n FROM scheduled_jobs"))!.n).toBe(1);
  });

  it("merge：保留現有、略過重複、重新對應 ID", async () => {
    const a = await setup();
    await seed(a);
    const backup = (await a.call("GET", "/api/admin/backup/export", undefined, a.auth)).json;
    // 同一環境再 merge：全部重複 → 略過
    const r1 = await a.call("POST", "/api/admin/backup/import?mode=merge", backup, a.auth);
    expect(r1.json.tables.storages).toEqual({ inserted: 0, skipped: 1 });
    expect(r1.json.tables.shares).toEqual({ inserted: 0, skipped: 1 });
    expect(r1.json.tables.api_keys).toEqual({ inserted: 0, skipped: 1 });
    // 另一環境已有一個儲存佔用 id 1 → 匯入的儲存拿到新 ID，掛載跟著改寫
    const b = await setup();
    const pre = await b.call("POST", "/api/admin/storages", { name: "既有", type: "memory", config: { label: "y", secretKey: "k2" } }, b.auth);
    expect(pre.status, JSON.stringify(pre.json)).toBe(201);
    const r2 = await b.call("POST", "/api/admin/backup/import", { mode: "merge", data: backup }, b.auth);
    expect(r2.status, JSON.stringify(r2.json)).toBe(200);
    expect(r2.json.tables.storages).toEqual({ inserted: 1, skipped: 0 });
    const m = await b.ctx.db.first<any>("SELECT m.storage_id, s.name FROM mounts m JOIN storages s ON s.id = m.storage_id WHERE m.mount_path = '/m'");
    expect(m.name).toBe("M");
    const acl = await b.ctx.db.first<any>("SELECT storage_id FROM api_key_acl");
    expect(acl.storage_id).toBe(m.storage_id);
    expect((await b.ctx.db.first<any>("SELECT COUNT(*) AS n FROM storages"))!.n).toBe(2);
  });

  it("APP_SECRET 不同時清空機密並警告；格式錯誤 400", async () => {
    const a = await setup();
    await seed(a);
    const backup = (await a.call("GET", "/api/admin/backup/export", undefined, a.auth)).json;
    const b = await setup({ APP_SECRET: "another-secret-abcdef" });
    const r = await b.call("POST", "/api/admin/backup/import", { mode: "replace", data: backup }, b.auth);
    expect(r.json.warnings[0]).toContain("APP_SECRET");
    expect((await b.ctx.db.first<any>("SELECT secrets FROM storages"))!.secrets).toBeNull();
    expect((await b.call("POST", "/api/admin/backup/import", { mode: "replace", data: { format: "x" } }, b.auth)).status).toBe(400);
    expect((await b.call("POST", "/api/admin/backup/import", { mode: "nuke", data: backup }, b.auth)).status).toBe(400);
    const evil = { ...backup, tables: { sessions: [] } };
    expect((await b.call("POST", "/api/admin/backup/import", { mode: "merge", data: evil }, b.auth)).status).toBe(400);
    const evil2 = { ...backup, tables: { settings: [{ key: "a", value: { x: 1 } }] } };
    expect((await b.call("POST", "/api/admin/backup/import", { mode: "merge", data: evil2 }, b.auth)).status).toBe(400);
  });
});
