import { afterEach, describe, expect, it, vi } from "vitest";
import { makeApp } from "./helpers/app";
import { cronTick } from "../src/modules/jobs/service";
import { runCron } from "../src/app";

afterEach(() => vi.restoreAllMocks());

async function setup() {
  const h = await makeApp();
  const auth = { authorization: `Bearer ${await h.login()}` };
  return { ...h, auth };
}

describe("排程工作", () => {
  it("CRUD 與驗證", async () => {
    const h = await setup();
    expect((await h.call("GET", "/api/admin/jobs")).status).toBe(401);
    const kinds = await h.call("GET", "/api/admin/jobs/kinds", undefined, h.auth);
    expect(kinds.json.items).toContainEqual({ kind: "cleanup.expired", label: "清除過期分享與工作階段" });
    expect((await h.call("POST", "/api/admin/jobs", { kind: "nope", name: "x", intervalSeconds: 3600 }, h.auth)).json.error.code).toBe("unknown_job_kind");
    expect((await h.call("POST", "/api/admin/jobs", { kind: "cleanup.expired", name: "x", intervalSeconds: 10 }, h.auth)).status).toBe(400);
    expect((await h.call("POST", "/api/admin/jobs", { kind: "cleanup.expired", name: "", intervalSeconds: 3600 }, h.auth)).status).toBe(400);
    const c = await h.call("POST", "/api/admin/jobs", { kind: "cleanup.expired", name: "清理", intervalSeconds: 3600, config: { deleteFiles: false } }, h.auth);
    expect(c.status).toBe(201);
    expect(c.json).toMatchObject({ kind: "cleanup.expired", name: "清理", intervalSeconds: 3600, enabled: true, config: { deleteFiles: false } });
    const u = await h.call("PATCH", `/api/admin/jobs/${c.json.id}`, { name: "每小時清理", enabled: false }, h.auth);
    expect(u.json).toMatchObject({ name: "每小時清理", enabled: false });
    expect((await h.call("GET", "/api/admin/jobs", undefined, h.auth)).json.items).toHaveLength(1);
    expect((await h.call("DELETE", `/api/admin/jobs/${c.json.id}`, undefined, h.auth)).status).toBe(200);
    expect((await h.call("GET", `/api/admin/jobs/${c.json.id}`, undefined, h.auth)).status).toBe(404);
  });

  it("cleanup.expired：立即執行清除過期分享／paste／工作階段，保留有效的", async () => {
    const h = await setup();
    const now = Date.now();
    const ins = (slug: string, exp: number | null, max: number | null, views: number) =>
      h.ctx.db.run("INSERT INTO shares (slug, object_path, filename, expires_at, max_views, views, created_by, created_at, updated_at) VALUES (?, '/a', 'a', ?, ?, ?, 'x', ?, ?)", [slug, exp, max, views, now, now]);
    await ins("old", now - 1000, null, 0);
    await ins("used", null, 3, 3);
    await ins("ok", now + 60_000, 3, 1);
    await h.ctx.db.run("INSERT INTO pastes (slug, content, expires_at, created_by, created_at, updated_at) VALUES ('p', 'x', ?, 'x', ?, ?)", [now - 1, now, now]);
    const c = await h.call("POST", "/api/admin/jobs", { kind: "cleanup.expired", name: "清理", intervalSeconds: 600 }, h.auth);
    const r = await h.call("POST", `/api/admin/jobs/${c.json.id}/run`, undefined, h.auth);
    expect(r.json.lastStatus).toBe("ok");
    expect(r.json.lastMessage).toContain("分享 2");
    expect(r.json.lastMessage).toContain("文字分享 1");
    expect(r.json.nextRunAt).toBeGreaterThan(now + 590_000);
    expect((await h.ctx.db.all<any>("SELECT slug FROM shares")).map((x) => x.slug)).toEqual(["ok"]);
  });

  it("cron：只執行到期且啟用的工作、寫回狀態、錯誤也排下一次、不重複認領", async () => {
    const h = await setup();
    const calls: string[] = [];
    (h.ctx.modules as any[]).push({
      name: "test-jobs",
      jobs: {
        "test.ok": async (_ctx: unknown, cfg: Record<string, unknown>) => {
          calls.push(String(cfg.tag));
          return "完成";
        },
        "test.fail": async () => {
          throw new Error("壞掉了");
        },
      },
    });
    try {
      const mk = (kind: string, tag: string, extra: any = {}) =>
        h.call("POST", "/api/admin/jobs", { kind, name: tag, intervalSeconds: 60, config: { tag }, ...extra }, h.auth);
      const due = await mk("test.ok", "due");
      await mk("test.ok", "future", { nextRunAt: Date.now() + 3600_000 });
      await mk("test.ok", "off", { enabled: false });
      const bad = await mk("test.fail", "bad");
      const now = Date.now();
      const ran = await cronTick(h.ctx, now);
      expect(ran.sort()).toEqual([due.json.id, bad.json.id].sort());
      expect(calls).toEqual(["due"]);
      const d = (await h.call("GET", `/api/admin/jobs/${due.json.id}`, undefined, h.auth)).json;
      expect(d).toMatchObject({ lastStatus: "ok", lastMessage: "完成", nextRunAt: now + 60_000 });
      const b = (await h.call("GET", `/api/admin/jobs/${bad.json.id}`, undefined, h.auth)).json;
      expect(b).toMatchObject({ lastStatus: "error", lastMessage: "壞掉了", nextRunAt: now + 60_000 });
      // 同一時間再喚醒：沒有到期的
      expect(await cronTick(h.ctx, now)).toEqual([]);
      // 一分鐘後：due 與 bad 再次到期；經由 app 的 runCron 呼叫各模組 cron
      vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
      await runCron(h.ctx);
      expect(calls).toEqual(["due", "due"]);
    } finally {
      (h.ctx.modules as any[]).pop();
    }
  });
});
