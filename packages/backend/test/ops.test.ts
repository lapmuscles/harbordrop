import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeApp } from "./helpers/app";
import { memFsStores, memfsDriver } from "./helpers/memory-driver";
import { DRIVERS } from "../src/storage/registry";
import { runCron } from "../src/app";
import { createTask, getTask, registerTaskHandler } from "../src/modules/tasks/service";
import { backupFilename } from "../src/modules/backup/service";

if (!DRIVERS.includes(memfsDriver)) DRIVERS.push(memfsDriver);
beforeEach(() => memFsStores.clear());

async function setup() {
  const h = await makeApp();
  const auth = { authorization: `Bearer ${await h.login()}` };
  const sid = (await h.call("POST", "/api/admin/storages", { name: "B", type: "memfs", config: { label: "BK" } }, auth)).json.id as number;
  return { ...h, auth, sid };
}

describe("排程接線", () => {
  it("runCron 同時執行到期的 jobs（cronTick）與推進 tasks（runTasks）", async () => {
    const h = await setup();
    const job = await h.call("POST", "/api/admin/jobs", { kind: "cleanup.expired", name: "清理", intervalSeconds: 3600 }, h.auth);
    expect(job.status).toBeLessThan(300);
    await h.ctx.db.run("UPDATE scheduled_jobs SET next_run_at = 1 WHERE id = ?", [job.json.id]);
    let ran = 0;
    registerTaskHandler("test.ops", async () => {
      ran++;
      return { done: true, result: { ok: 1 } };
    });
    const tid = await createTask(h.ctx, "test.ops", {});
    await runCron(h.ctx);
    expect(ran).toBe(1);
    expect((await getTask(h.ctx, tid)).status).toBe("succeeded");
    const row = await h.ctx.db.first<any>("SELECT last_status, last_run_at FROM scheduled_jobs WHERE id = ?", [job.json.id]);
    expect(row.last_run_at).toBeTruthy();
    expect(row.last_status).toBe("ok");
  });

  it("worker.ts 有 scheduled()、node.ts 每 60 秒呼叫 runCron、wrangler.toml 有每分鐘 cron", () => {
    const root = join(__dirname, "../../..");
    const worker = readFileSync(join(root, "packages/backend/src/runtime/worker.ts"), "utf8");
    const node = readFileSync(join(root, "packages/backend/src/runtime/node.ts"), "utf8");
    const toml = readFileSync(join(root, "wrangler.toml"), "utf8");
    expect(worker).toMatch(/async scheduled\([\s\S]*runCron/);
    expect(node).toMatch(/setInterval\([\s\S]*runCron[\s\S]*60_000\)/);
    expect(toml).toMatch(/\[triggers\]\s*\ncrons = \["\* \* \* \* \*"\]/);
  });
});

describe("jobs kind：backup.export", () => {
  it("列在 /api/admin/jobs/kinds", async () => {
    const h = await setup();
    const r = await h.call("GET", "/api/admin/jobs/kinds", undefined, h.auth);
    expect(r.json.items).toContainEqual({ kind: "backup.export", label: "匯出備份" });
  });

  it("以驅動 put 寫入指定 storageId + path（資料夾路徑自動加檔名）", async () => {
    const h = await setup();
    const j = await h.call("POST", "/api/admin/jobs", { kind: "backup.export", name: "備份", intervalSeconds: 86400, config: { storageId: h.sid, path: "/backups/" } }, h.auth);
    const run = await h.call("POST", `/api/admin/jobs/${j.json.id}/run`, undefined, h.auth);
    expect(run.json.lastStatus).toBe("ok");
    expect(run.json.lastMessage).toMatch(/已匯出備份/);
    const files = [...(memFsStores.get("BK")?.entries() ?? [])].filter(([k, v]) => v !== "dir" && k.startsWith("/backups/"));
    expect(files).toHaveLength(1);
    expect(files[0][0]).toMatch(/^\/backups\/harbordrop-backup-\d{8}-\d{6}\.json$/);
    const data = JSON.parse(new TextDecoder().decode(files[0][1] as Uint8Array));
    expect(data.format).toBe("harbordrop-backup");
    expect(data.tables.storages).toHaveLength(1);
  });

  it("指定檔名與 {date}；storageId 錯誤時記錄失敗", async () => {
    const h = await setup();
    const j = await h.call("POST", "/api/admin/jobs", { kind: "backup.export", name: "備份", intervalSeconds: 86400, config: { storageId: h.sid, path: "bk-{date}.json" } }, h.auth);
    await h.call("POST", `/api/admin/jobs/${j.json.id}/run`, undefined, h.auth);
    const keys = [...(memFsStores.get("BK")?.keys() ?? [])];
    expect(keys.some((k) => /^\/bk-\d{8}-\d{6}\.json$/.test(k))).toBe(true);
    const bad = await h.call("POST", "/api/admin/jobs", { kind: "backup.export", name: "壞", intervalSeconds: 86400, config: { path: "/x.json" } }, h.auth);
    const r = await h.call("POST", `/api/admin/jobs/${bad.json.id}/run`, undefined, h.auth);
    expect(r.json.lastStatus).not.toBe("ok");
    expect(backupFilename(Date.UTC(2026, 10, 14, 1, 2, 3))).toBe("harbordrop-backup-20261114-010203.json");
  });
});

import { clientIp, trustProxy } from "../src/modules/auth/ratelimit";

describe("用戶端 IP 與 TRUST_PROXY", () => {
  const fake = (platform: "node" | "workers", env: Record<string, string>, headers: Record<string, string>, remote?: string) =>
    ({
      req: { header: (n: string) => headers[n.toLowerCase()] },
      get: (k: string) => (k === "ctx" ? { platform, env } : undefined),
      env: remote ? { incoming: { socket: { remoteAddress: remote } } } : {},
    }) as any;
  const H = { "x-forwarded-for": "6.6.6.6, 10.0.0.1", "x-real-ip": "7.7.7.7", "cf-connecting-ip": "8.8.8.8" };

  it("trustProxy 解析", () => {
    expect(trustProxy({})).toBe(false);
    expect(trustProxy({ TRUST_PROXY: "false" })).toBe(false);
    expect(trustProxy({ TRUST_PROXY: "true" })).toBe(true);
    expect(trustProxy({ TRUST_PROXY: "1" })).toBe(true);
  });

  it("Node 預設（false）：忽略 X-Forwarded-For 等標頭，只用連線位址", () => {
    expect(clientIp(fake("node", {}, H, "1.2.3.4"))).toBe("1.2.3.4");
    expect(clientIp(fake("node", { TRUST_PROXY: "false" }, { "x-forwarded-for": "6.6.6.6" }, "1.2.3.4"))).toBe("1.2.3.4");
    expect(clientIp(fake("node", {}, H))).toBe("unknown");
  });

  it("Node 且 TRUST_PROXY=true：採用代理標頭", () => {
    expect(clientIp(fake("node", { TRUST_PROXY: "true" }, { "x-forwarded-for": "6.6.6.6, 10.0.0.1" }, "10.0.0.1"))).toBe("6.6.6.6");
    expect(clientIp(fake("node", { TRUST_PROXY: "true" }, {}, "10.0.0.1"))).toBe("10.0.0.1");
  });

  it("Workers：只用 CF-Connecting-IP", () => {
    expect(clientIp(fake("workers", {}, H))).toBe("8.8.8.8");
    expect(clientIp(fake("workers", {}, { "x-forwarded-for": "6.6.6.6" }))).toBe("unknown");
  });
});
