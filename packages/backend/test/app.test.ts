import { describe, expect, it, beforeEach } from "vitest";
import { makeApp } from "./helpers/app";
import { memFiles } from "./helpers/memory-driver";

beforeEach(() => memFiles.clear());

async function setup() {
  const h = await makeApp();
  const token = await h.login();
  const auth = { authorization: `Bearer ${token}` };
  const st = await h.call("POST", "/api/admin/storages", { name: "M", type: "memory", config: { label: "x", secretKey: "s3cret" } }, auth);
  return { ...h, auth, storageId: st.json.id as number, st };
}

async function upload(h: Awaited<ReturnType<typeof setup>>, bytes: Uint8Array, share: any = {}, headers: Record<string, string> = h.auth) {
  const init = await h.call("POST", "/api/uploads", { storageId: h.storageId, filename: "測試.txt", size: bytes.byteLength, share }, headers);
  if (init.status !== 201) return { init };
  const up = { "x-upload-token": init.json.uploadToken };
  await h.call("PUT", `/api/uploads/${init.json.sessionId}/action/put`, bytes, up);
  const done = await h.call("POST", `/api/uploads/${init.json.sessionId}/complete`, {}, up);
  return { init, done };
}

describe("管理員登入", () => {
  it("錯誤密碼 401，正確則取得 session", async () => {
    const h = await makeApp();
    expect((await h.call("POST", "/api/auth/login", { username: "admin", password: "x" })).status).toBe(401);
    const t = await h.login();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    const me = await h.call("GET", "/api/auth/me", undefined, { authorization: `Bearer ${t}` });
    expect(me.json).toEqual({ kind: "admin", username: "admin" });
    await h.call("POST", "/api/auth/logout", undefined, { authorization: `Bearer ${t}` });
    expect((await h.call("GET", "/api/auth/me", undefined, { authorization: `Bearer ${t}` })).json.kind).toBe("anon");
  });
  it("管理 API 需要登入", async () => {
    const h = await makeApp();
    expect((await h.call("GET", "/api/admin/storages")).status).toBe(401);
  });
});

describe("儲存設定", () => {
  it("機密欄位不回傳；更新時留空保留舊值", async () => {
    const h = await setup();
    expect(h.st.status).toBe(201);
    expect(h.st.json.secretsSet).toEqual(["secretKey"]);
    expect(JSON.stringify(h.st.json)).not.toContain("s3cret");
    const raw = await h.ctx.db.first<{ secrets: string }>("SELECT secrets FROM storages");
    expect(raw!.secrets).not.toContain("s3cret");
    await h.call("PUT", `/api/admin/storages/${h.storageId}`, { name: "M2", config: { label: "y", secretKey: "" } }, h.auth);
    const t = await h.call("POST", `/api/admin/storages/${h.storageId}/test`, undefined, h.auth);
    expect(t.json.ok).toBe(true);
    const list = await h.call("GET", "/api/admin/storages", undefined, h.auth);
    expect(list.json[0]).toMatchObject({ name: "M2", config: { label: "y" } });
  });
  it("必填機密欄位缺少時 400", async () => {
    const h = await makeApp();
    const t = await h.login();
    const r = await h.call("POST", "/api/admin/storages", { name: "x", type: "memory", config: {} }, { authorization: `Bearer ${t}` });
    expect(r.status).toBe(400);
  });
});

describe("上傳與分享", () => {
  it("完整流程：上傳 → 分享資訊 → 下載計次 → 次數上限", async () => {
    const h = await setup();
    const { done } = await upload(h, new TextEncoder().encode("hello"), { maxViews: 2, slug: "my-file" });
    expect(done!.json.url).toBe("http://local/f/my-file");
    const info = await h.call("GET", "/api/shares/my-file");
    expect(info.json).toMatchObject({ filename: "測試.txt", size: 5, views: 0, previewKind: "text", passwordRequired: false });
    expect((await h.call("GET", "/api/shares/my-file/content")).text).toBe("hello");
    // Range 續傳不計次
    await h.call("GET", "/api/shares/my-file/content", undefined, { range: "bytes=2-" });
    expect((await h.call("GET", "/api/shares/my-file")).json.views).toBe(1);
    expect((await h.call("GET", "/api/shares/my-file/content")).status).toBe(200);
    expect((await h.call("GET", "/api/shares/my-file/content")).status).toBe(410);
  });
  it("自訂連結重複 409、格式錯誤 400", async () => {
    const h = await setup();
    await upload(h, new Uint8Array(3), { slug: "dup-1" });
    expect((await upload(h, new Uint8Array(3), { slug: "dup-1" })).init.status).toBe(409);
    expect((await upload(h, new Uint8Array(3), { slug: "a/b" })).init.status).toBe(400);
  });
  it("密碼保護：未解鎖 401，解鎖後可下載", async () => {
    const h = await setup();
    const { done } = await upload(h, new Uint8Array([1, 2, 3]), { password: "pw" });
    const slug = done!.json.share.slug;
    expect(done!.json.share.passwordRequired).toBe(true);
    expect((await h.call("GET", `/api/shares/${slug}/content`)).status).toBe(401);
    expect((await h.call("POST", `/api/shares/${slug}/unlock`, { password: "bad" })).status).toBe(401);
    const tok = (await h.call("POST", `/api/shares/${slug}/unlock`, { password: "pw" })).json.token;
    expect((await h.call("GET", `/api/shares/${slug}/content?t=${encodeURIComponent(tok)}`)).status).toBe(200);
  });
  it("到期後 410", async () => {
    const h = await setup();
    const { done } = await upload(h, new Uint8Array(1), { expiresInHours: 1 });
    await h.ctx.db.run("UPDATE shares SET expires_at = ?", [Date.now() - 1]);
    expect((await h.call("GET", `/api/shares/${done!.json.share.slug}`)).status).toBe(410);
  });
  it("匿名上傳：預設拒絕；開啟設定且儲存允許後可上傳，受大小上限限制", async () => {
    const h = await setup();
    expect((await upload(h, new Uint8Array(1), {}, {})).init.status).toBe(403);
    await h.call("PUT", "/api/admin/settings", { allowAnonymousUpload: true, anonymousMaxBytes: 10 }, h.auth);
    expect((await upload(h, new Uint8Array(1), {}, {})).init.status).toBe(403); // 儲存未允許
    await h.call("PUT", `/api/admin/storages/${h.storageId}`, { allowAnonymousUpload: true }, h.auth);
    const cfg = await h.call("GET", "/api/public/config");
    expect(cfg.json.uploadStorages).toHaveLength(1);
    expect((await upload(h, new Uint8Array(11), {}, {})).init.status).toBe(400);
    const ok = await upload(h, new Uint8Array(5), {}, {});
    expect(ok.done!.status).toBe(200);
  });
  it("上傳權杖錯誤時 403", async () => {
    const h = await setup();
    const init = await h.call("POST", "/api/uploads", { storageId: h.storageId, filename: "a", size: 1 }, h.auth);
    expect((await h.call("POST", `/api/uploads/${init.json.sessionId}/complete`, {}, { "x-upload-token": "nope" })).status).toBe(403);
  });
  it("管理員刪除分享並刪除檔案", async () => {
    const h = await setup();
    const { done } = await upload(h, new Uint8Array(2));
    expect(memFiles.size).toBe(1);
    await h.call("DELETE", `/api/admin/shares/${done!.json.share.slug}?deleteFile=1`, undefined, h.auth);
    expect(memFiles.size).toBe(0);
    expect((await h.call("GET", `/api/shares/${done!.json.share.slug}`)).status).toBe(404);
  });
});
