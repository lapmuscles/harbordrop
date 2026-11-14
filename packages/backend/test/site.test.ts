import { beforeEach, describe, expect, it } from "vitest";
import { makeApp } from "./helpers/app";
import { memFiles } from "./helpers/memory-driver";
import { HOUR_MS, hitAnonLimit, pruneAnonRate } from "../src/core/anonlimit";
import { adminStats } from "../src/modules/site";

beforeEach(() => memFiles.clear());

async function setup(env: Record<string, string> = { TRUST_PROXY: "1" }) {
  const h = await makeApp(env);
  const auth = { authorization: `Bearer ${await h.login()}` };
  const st = await h.call("POST", "/api/admin/storages", { name: "M", type: "memory", config: { label: "x", secretKey: "s" }, allowAnonymousUpload: true }, auth);
  return { ...h, auth, storageId: st.json.id as number };
}

describe("GET /api/site", () => {
  it("只回非敏感欄位，反映設定值", async () => {
    const h = await setup();
    await h.ctx.settings.update({ siteTitle: "我的站", siteAnnouncement: "# 公告", siteFooter: "© 2026", allowAnonymousPaste: true, anonPastePerHour: 5, fsPublicBrowse: true });
    const r = await h.call("GET", "/api/site");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      siteTitle: "我的站",
      announcement: "# 公告",
      footer: "© 2026",
      defaultLanguage: "zh-TW",
      allowAnonymousPaste: true,
      anonPastePerHour: 5,
      fsPublicBrowse: true,
      allowAnonymousUpload: false,
    });
    const keys = Object.keys(r.json).join(",");
    expect(keys).not.toMatch(/uploadPathTemplate|secret|password|anonymousMaxExpiryHours/i);
  });

  it("不支援的語言回退 zh-TW；設定定義含 textarea／options 提示", async () => {
    const h = await setup();
    await h.ctx.settings.update({ defaultLanguage: "xx" });
    expect((await h.call("GET", "/api/site")).json.defaultLanguage).toBe("zh-TW");
    const defs = (await h.call("GET", "/api/admin/settings", undefined, h.auth)).json.definitions as any[];
    expect(defs.find((d) => d.key === "siteAnnouncement").input).toBe("textarea");
    expect(defs.find((d) => d.key === "defaultLanguage").options[0].value).toBe("zh-TW");
  });
});

describe("GET /api/admin/stats", () => {
  it("需要管理員", async () => {
    const h = await setup();
    expect((await h.call("GET", "/api/admin/stats")).status).toBe(401);
  });

  it("統計數量、位元組、7 日分佈、執行中任務、最近 10 筆分享", async () => {
    const h = await setup();
    const now = Date.UTC(2026, 10, 14, 12, 0, 0);
    const ins = (slug: string, size: number, at: number) =>
      h.ctx.db.run("INSERT INTO shares (slug, storage_id, object_path, filename, size, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'anon', ?, ?)", [
        slug, h.storageId, `/${slug}`, `${slug}.txt`, size, at, at,
      ]);
    for (let i = 0; i < 12; i++) await ins(`s${i}`, 100, now - i * 3600_000); // 今天 12 筆（UTC 00:00–12:00）
    await ins("y1", 50, now - 86_400_000); // 昨天
    await ins("old", 999, now - 30 * 86_400_000); // 範圍外
    await h.ctx.db.run("INSERT INTO pastes (slug, content, created_by, created_at, updated_at) VALUES ('p1', 'x', 'anon', 1, 1)");
    await h.ctx.db.run("INSERT INTO tasks (id, kind, status, created_by, created_at, updated_at) VALUES ('t1', 'copy', 'running', 'admin:1', 1, 1), ('t2', 'copy', 'pending', 'admin:1', 1, 1), ('t3', 'copy', 'succeeded', 'admin:1', 1, 1)");
    const s = await adminStats(h.ctx, 0, now);
    expect(s).toMatchObject({ shares: 14, pastes: 1, storages: 1, mounts: 0, totalUploadBytes: 1200 + 50 + 999, runningTasks: 1, pendingTasks: 1 });
    expect(s.dailyUploads).toHaveLength(7);
    expect(s.dailyUploads[6]).toEqual({ date: "2026-11-14", count: 12, bytes: 1200 });
    expect(s.dailyUploads[5]).toEqual({ date: "2026-11-13", count: 1, bytes: 50 });
    expect(s.dailyUploads[0].date).toBe("2026-11-08");
    expect(s.recentShares).toHaveLength(10);
    expect(s.recentShares[0].slug).toBe("s0");

    // UTC-4（getTimezoneOffset = 240）：UTC 00:00–03:59 的分享屬於當地前一天
    const tz = await adminStats(h.ctx, 240, now);
    expect(tz.dailyUploads[6].date).toBe("2026-11-14");
    expect(tz.dailyUploads[6].count).toBe(9); // UTC 04:00–12:00
    expect(tz.dailyUploads[5].count).toBe(3 + 1);

    const r = await h.call("GET", "/api/admin/stats?tzOffset=240", undefined, h.auth);
    expect(r.status).toBe(200);
    expect(r.json.dailyUploads).toHaveLength(7);
  });
});

describe("匿名速率限制", () => {
  it("匿名 paste：每 IP 每小時 N 次，超過 429；不同 IP 各自計算；管理員不受限", async () => {
    const h = await setup();
    await h.ctx.settings.update({ allowAnonymousPaste: true, anonPastePerHour: 2 });
    const ip = (a: string) => ({ "x-forwarded-for": a });
    expect((await h.call("POST", "/api/pastes", { content: "a" }, ip("1.1.1.1"))).status).toBe(201);
    expect((await h.call("POST", "/api/pastes", { content: "b" }, ip("1.1.1.1"))).status).toBe(201);
    const third = await h.call("POST", "/api/pastes", { content: "c" }, ip("1.1.1.1"));
    expect(third.status).toBe(429);
    expect(third.json.error.code).toBe("anon_rate_limited");
    expect((await h.call("POST", "/api/pastes", { content: "d" }, ip("2.2.2.2"))).status).toBe(201);
    for (let i = 0; i < 3; i++) expect((await h.call("POST", "/api/pastes", { content: "x" }, { ...h.auth, ...ip("1.1.1.1") })).status).toBe(201);
  });

  it("匿名上傳受限；0 = 不限", async () => {
    const h = await setup();
    await h.ctx.settings.update({ allowAnonymousUpload: true, anonUploadPerHour: 1 });
    const init = () => h.call("POST", "/api/uploads", { storageId: h.storageId, filename: "a.txt", size: 1 }, { "x-real-ip": "9.9.9.9" });
    expect((await init()).status).toBe(201);
    expect((await init()).status).toBe(429);
    await h.ctx.settings.update({ anonUploadPerHour: 0 });
    expect((await init()).status).toBe(201);
  });

  it("TRUST_PROXY 未設定時忽略 X-Forwarded-For（偽造標頭無法繞過）", async () => {
    const h = await setup({});
    await h.ctx.settings.update({ allowAnonymousPaste: true, anonPastePerHour: 1 });
    expect((await h.call("POST", "/api/pastes", { content: "a" }, { "x-forwarded-for": "1.1.1.1" })).status).toBe(201);
    expect((await h.call("POST", "/api/pastes", { content: "b" }, { "x-forwarded-for": "3.3.3.3" })).status).toBe(429);
  });

  it("固定一小時視窗：下一小時重新計數；prune 刪除舊視窗", async () => {
    const h = await setup();
    await h.ctx.settings.update({ anonPastePerHour: 1 });
    const t0 = 10 * HOUR_MS + 1000;
    await hitAnonLimit(h.ctx, "paste", "ip", t0);
    await expect(hitAnonLimit(h.ctx, "paste", "ip", t0 + 1000)).rejects.toMatchObject({ status: 429 });
    expect(await hitAnonLimit(h.ctx, "paste", "ip", t0 + HOUR_MS)).toEqual({ count: 1, limit: 1 });
    await hitAnonLimit(h.ctx, "upload", "other", t0);
    await h.ctx.settings.update({ anonUploadPerHour: 5 });
    expect(await pruneAnonRate(h.ctx, t0 + HOUR_MS)).toBe(1);
  });
});
