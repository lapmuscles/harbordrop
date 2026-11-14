import { beforeEach, describe, expect, it } from "vitest";
import { HdApiError, HdClient, type ProtocolHandler } from "@harbordrop/shared/upload";
import { makeApp } from "./helpers/app";
import { memFsStores, memfsDriver } from "./helpers/memory-driver";
import { DRIVERS } from "../src/storage/registry";
import type { DriverDefinition } from "../src/storage/types";
import { fsUpload } from "../../frontend/src/fs/upload";

/** 只能經後端 put 的版本（無 initUpload）→ fs/upload/init 回 protocol=proxy */
const memproxyDriver: DriverDefinition = {
  ...memfsDriver,
  type: "memproxy",
  create(config, ctx) {
    const d = memfsDriver.create(config, ctx) as any;
    const { initUpload, uploadAction, completeUpload, ...rest } = d;
    return { ...rest, capabilities: { ...d.capabilities, uploadProtocols: ["proxy"] } };
  },
};
for (const def of [memfsDriver, memproxyDriver]) if (!DRIVERS.includes(def)) DRIVERS.push(def);
beforeEach(() => memFsStores.clear());

/** 測試用 mem-direct 協定（同前端 PROTOCOLS 的介面）：PUT 整檔到 action/put */
const memDirect: ProtocolHandler = async (api, s, file, hooks) => {
  const r = await api.fetch(`${api.baseUrl}/api/uploads/${s.sessionId}/action/put`, { method: "PUT", headers: api.sessionHeaders(s), body: new Uint8Array(await file.arrayBuffer()) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  hooks.onProgress?.({ phase: "uploading", fraction: 1, loaded: file.size, total: file.size });
  return { stats: { protocol: "mem-direct", attempts: [], skipped: 0, startedAt: Date.now() }, completeBody: {} };
};

async function setup() {
  const h = await makeApp();
  const token = await h.login();
  const auth = { authorization: `Bearer ${token}` };
  const mk = async (name: string, type: string) => (await h.call("POST", "/api/admin/storages", { name, type, config: { label: name } }, auth)).json.id as number;
  await h.call("POST", "/api/admin/mounts", { mountPath: "/a", storageId: await mk("A", "memfs"), rootPath: "/data" }, auth);
  await h.call("POST", "/api/admin/mounts", { mountPath: "/p", storageId: await mk("P", "memproxy") }, auth);
  const appFetch = ((input: RequestInfo | URL, init?: RequestInit) => h.app.fetch(new Request(input, init))) as typeof fetch;
  return { ...h, token, auth, appFetch };
}

describe("檔案總管上傳流程（前端 fsUpload ↔ 後端 /api/fs/upload/*）", () => {
  it("直傳：init → 協定 → complete，回報進度", async () => {
    const h = await setup();
    const api = new HdClient({ baseUrl: "http://local", token: h.token, fetch: h.appFetch });
    const phases: string[] = [];
    const r = await fsUpload(api, "/a/sub", new Blob(["你好，世界"]), "說明.txt", { protocols: { "mem-direct": memDirect }, onProgress: (p) => phases.push(p.phase) });
    expect(r).toEqual({ protocol: "mem-direct", path: "/a/sub/說明.txt" });
    expect(phases).toEqual(["uploading", "committing", "done"]);
    expect(new TextDecoder().decode(memFsStores.get("A")!.get("/data/sub/說明.txt") as Uint8Array)).toBe("你好，世界");
    const list = await h.call("GET", "/api/fs/list?path=/a/sub", undefined, h.auth);
    expect(list.json.entries.map((e: any) => e.name)).toEqual(["說明.txt"]);
  });

  it("不支援直傳的儲存走 proxy PUT", async () => {
    const h = await setup();
    const api = new HdClient({ baseUrl: "http://local", token: h.token, fetch: h.appFetch });
    let initProto = "";
    const r = await fsUpload(api, "/p", new Blob(["proxy!"]), "x.bin", { onInit: (i) => (initProto = i.protocol) });
    expect(initProto).toBe("proxy");
    expect(r.protocol).toBe("proxy");
    expect(new TextDecoder().decode(memFsStores.get("P")!.get("/x.bin") as Uint8Array)).toBe("proxy!");
  });

  it("未知協定與未登入時拋出錯誤", async () => {
    const h = await setup();
    const api = new HdClient({ baseUrl: "http://local", token: h.token, fetch: h.appFetch });
    await expect(fsUpload(api, "/a", new Blob(["x"]), "a.txt", { protocols: {} })).rejects.toThrow("瀏覽器不支援上傳協定：mem-direct");
    const anon = new HdClient({ baseUrl: "http://local", fetch: h.appFetch });
    const err = await fsUpload(anon, "/a", new Blob(["x"]), "a.txt").catch((e) => e);
    expect(err).toBeInstanceOf(HdApiError);
    expect(err.status).toBe(401);
  });

  it("密碼目錄：一般使用者需帶 X-Fs-Token 才能上傳（管理員略過）", async () => {
    const h = await setup();
    await h.call("POST", "/api/admin/fs-meta", { path: "/p/lock", password: "open" }, h.auth);
    await h.call("POST", "/api/fs/mkdir", { path: "/p/lock" }, h.auth);
    // 管理員略過密碼
    const admin = new HdClient({ baseUrl: "http://local", token: h.token, fetch: h.appFetch });
    expect((await fsUpload(admin, "/p/lock", new Blob(["a"]), "a.txt")).protocol).toBe("proxy");
    // 解鎖權杖可由匿名取得；確認 fs/upload/init 會依 X-Fs-Token 判斷（匿名仍因未登入被擋 → 401，而非 403 password_required）
    const un = await h.call("POST", "/api/fs/unlock", { path: "/p/lock", password: "open" });
    expect(un.json.token).toBeTruthy();
    const anon = new HdClient({ baseUrl: "http://local", fetch: h.appFetch });
    const e = await fsUpload(anon, "/p/lock", new Blob(["b"]), "b.txt", { headers: { "X-Fs-Token": un.json.token } }).catch((x) => x);
    expect(e.status).toBe(401);
  });
});
