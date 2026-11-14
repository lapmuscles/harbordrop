import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers/app";
import { deleteExpiredPastes, normalizeFormat } from "../src/modules/pastes/service";

async function setup() {
  const h = await makeApp();
  const auth = { authorization: `Bearer ${await h.login()}` };
  return { ...h, auth };
}

describe("pastes 建立", () => {
  it("匿名預設不可建立；開啟後可建立且到期受 anonymousMaxExpiryHours 限制", async () => {
    const h = await setup();
    expect((await h.call("POST", "/api/pastes", { content: "hi" })).status).toBe(401);
    await h.ctx.settings.update({ allowAnonymousPaste: true, anonymousMaxExpiryHours: 2 });
    const r = await h.call("POST", "/api/pastes", { content: "hi", expiresInHours: 0 });
    expect(r.status).toBe(201);
    expect(r.json.url).toBe(`/p/${r.json.paste.slug}`);
    expect(r.json.paste.expiresAt).toBeGreaterThan(Date.now());
    expect(r.json.paste.expiresAt).toBeLessThanOrEqual(Date.now() + 2 * 3600_000);
    const row = await h.ctx.db.first<{ created_by: string }>("SELECT created_by FROM pastes");
    expect(row!.created_by).toBe("anon");
  });

  it("管理員建立：自訂 slug、格式驗證、slug 重複 409、空內容 400、超過上限 400", async () => {
    const h = await setup();
    const r = await h.call("POST", "/api/pastes", { content: "# 標題", format: "markdown", slug: "my-note", title: "筆記" }, h.auth);
    expect(r.status).toBe(201);
    expect(r.json.paste).toMatchObject({ slug: "my-note", title: "筆記", format: "markdown", size: 8, passwordRequired: false });
    expect((await h.call("POST", "/api/pastes", { content: "x", slug: "my-note" }, h.auth)).status).toBe(409);
    expect((await h.call("POST", "/api/pastes", { content: "x", slug: "api" }, h.auth)).status).toBe(400);
    expect((await h.call("POST", "/api/pastes", { content: "" }, h.auth)).status).toBe(400);
    expect((await h.call("POST", "/api/pastes", { content: "x", format: "evil<script>" }, h.auth)).status).toBe(400);
    await h.ctx.settings.update({ pasteMaxBytes: 4 });
    expect((await h.call("POST", "/api/pastes", { content: "12345" }, h.auth)).json.error.code).toBe("paste_too_large");
  });

  it("normalizeFormat", () => {
    expect(normalizeFormat(undefined)).toBe("markdown");
    expect(normalizeFormat("CODE:TypeScript")).toBe("code:typescript");
    expect(normalizeFormat("text")).toBe("text");
    expect(() => normalizeFormat("html")).toThrow();
  });
});

describe("pastes 檢視、計次、密碼", () => {
  it("GET 回內容並計次；?meta=1 不計次；達上限 410", async () => {
    const h = await setup();
    const { slug } = (await h.call("POST", "/api/pastes", { content: "abc", maxViews: 2, format: "code:python" }, h.auth)).json.paste;
    const meta = await h.call("GET", `/api/pastes/${slug}?meta=1`);
    expect(meta.json.content).toBeUndefined();
    expect(meta.json.views).toBe(0);
    const a = await h.call("GET", `/api/pastes/${slug}`);
    expect(a.json).toMatchObject({ content: "abc", views: 1, format: "code:python" });
    const raw = await h.call("GET", `/api/pastes/${slug}/raw`);
    expect(raw.text).toBe("abc");
    expect(raw.headers.get("content-type")).toContain("text/plain");
    const c = await h.call("GET", `/api/pastes/${slug}`);
    expect(c.status).toBe(410);
    expect(c.json.error.code).toBe("paste_exhausted");
  });

  it("密碼：未解鎖不給內容、不計次；錯誤密碼 401；token 可讀 GET 與 raw", async () => {
    const h = await setup();
    const { slug, passwordRequired } = (await h.call("POST", "/api/pastes", { content: "secret", password: "pw" }, h.auth)).json.paste;
    expect(passwordRequired).toBe(true);
    const locked = await h.call("GET", `/api/pastes/${slug}`);
    expect(locked.json.content).toBeUndefined();
    expect(locked.json.views).toBe(0);
    expect((await h.call("GET", `/api/pastes/${slug}/raw`)).status).toBe(401);
    expect((await h.call("POST", `/api/pastes/${slug}/unlock`, { password: "nope" })).status).toBe(401);
    const { token } = (await h.call("POST", `/api/pastes/${slug}/unlock`, { password: "pw" })).json;
    expect((await h.call("GET", `/api/pastes/${slug}?t=${token}`)).json.content).toBe("secret");
    expect((await h.call("GET", `/api/pastes/${slug}/raw`, undefined, { "x-paste-token": token })).text).toBe("secret");
    // 其他 paste 的 token 不通用
    const other = (await h.call("POST", "/api/pastes", { content: "o", password: "pw" }, h.auth)).json.paste.slug;
    expect((await h.call("GET", `/api/pastes/${other}/raw?t=${token}`)).status).toBe(401);
  });

  it("過期 410；不存在 404", async () => {
    const h = await setup();
    const { slug } = (await h.call("POST", "/api/pastes", { content: "x", expiresInHours: 1 }, h.auth)).json.paste;
    await h.ctx.db.run("UPDATE pastes SET expires_at = ? WHERE slug = ?", [Date.now() - 1, slug]);
    expect((await h.call("GET", `/api/pastes/${slug}`)).json.error.code).toBe("paste_expired");
    expect((await h.call("GET", "/api/pastes/nope-nope")).status).toBe(404);
    expect(await deleteExpiredPastes(h.ctx)).toBe(1);
  });
});

describe("pastes 管理", () => {
  it("需要管理員；列表、讀取、修改、刪除", async () => {
    const h = await setup();
    expect((await h.call("GET", "/api/admin/pastes")).status).toBe(401);
    const { slug } = (await h.call("POST", "/api/pastes", { content: "hello world", title: "T", remark: "備註" }, h.auth)).json.paste;
    await h.call("GET", `/api/pastes/${slug}`);
    const list = await h.call("GET", "/api/admin/pastes?q=備", undefined, h.auth);
    expect(list.json.total).toBe(1);
    expect(list.json.items[0]).toMatchObject({ slug, excerpt: "hello world", remark: "備註", createdBy: "admin:1", views: 1 });
    expect(list.json.items[0].content).toBeUndefined();
    const one = await h.call("GET", `/api/admin/pastes/${slug}`, undefined, h.auth);
    expect(one.json).toMatchObject({ content: "hello world", views: 1, status: "ok" });
    await h.call("PATCH", `/api/admin/pastes/${slug}`, { content: "改過", maxViews: 5, resetViews: true, password: "p2", format: "text" }, h.auth);
    const after = await h.call("GET", `/api/pastes/${slug}?meta=1`);
    expect(after.json).toMatchObject({ views: 0, maxViews: 5, passwordRequired: true, format: "text", size: 6 });
    await h.call("PATCH", `/api/admin/pastes/${slug}`, { password: null }, h.auth);
    expect((await h.call("GET", `/api/pastes/${slug}`)).json.content).toBe("改過");
    expect((await h.call("DELETE", `/api/admin/pastes/${slug}`, undefined, h.auth)).json.ok).toBe(true);
    expect((await h.call("GET", `/api/pastes/${slug}`)).status).toBe(404);
  });

  it("公開設定包含 allowAnonymousPaste 與 pasteMaxBytes", async () => {
    const h = await setup();
    const cfg = await h.call("GET", "/api/public/config");
    expect(cfg.json).toMatchObject({ allowAnonymousPaste: false, pasteMaxBytes: 1048576 });
  });
});
