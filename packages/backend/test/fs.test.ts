import { beforeEach, describe, expect, it } from "vitest";
import { makeApp } from "./helpers/app";
import { memFsStores, memfsDriver } from "./helpers/memory-driver";
import { DRIVERS } from "../src/storage/registry";
import { tasksModule } from "../src/modules/tasks";
import { createTask, finish, getTask, updateProgress } from "../src/modules/tasks/service";
import { ancestors, isHidden } from "../src/modules/fsmeta/service";
import { resolveIn, virtualChildren, type MountRow } from "../src/modules/fs/mounts";

if (!DRIVERS.includes(memfsDriver)) DRIVERS.push(memfsDriver);
beforeEach(() => memFsStores.clear());

const enc = (s: string) => new TextEncoder().encode(s);
const put = (label: string, path: string, s: string) => {
  const m = memFsStores.get(label) ?? new Map([["/", "dir" as const]]);
  memFsStores.set(label, m);
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) m.set("/" + parts.slice(0, i).join("/"), "dir");
  m.set(path, enc(s));
};

async function setup() {
  const h = await makeApp();
  const auth = { authorization: `Bearer ${await h.login()}` };
  const mk = async (label: string, extra: Record<string, unknown> = {}) =>
    (await h.call("POST", "/api/admin/storages", { name: label, type: "memfs", config: { label, ...extra } }, auth)).json.id as number;
  const a = await mk("A");
  const b = await mk("B");
  const m1 = await h.call("POST", "/api/admin/mounts", { mountPath: "/a", storageId: a, rootPath: "/data" }, auth);
  const m2 = await h.call("POST", "/api/admin/mounts", { mountPath: "/deep/b", storageId: b }, auth);
  return { ...h, auth, a, b, mk, m1, m2 };
}

describe("掛載解析（純函式）", () => {
  const m = (id: number, mount_path: string, root_path = "/") => ({ id, mount_path, storage_id: id, root_path }) as MountRow;
  const mounts = [m(1, "/a", "/data"), m(2, "/a/x"), m(3, "/deep/b")];
  it("取最長相符", () => {
    expect(resolveIn(mounts, "/a/f.txt")).toMatchObject({ storageId: 1, rel: "/data/f.txt", rest: "/f.txt" });
    expect(resolveIn(mounts, "/a/x/y")).toMatchObject({ storageId: 2, rel: "/y" });
    expect(resolveIn(mounts, "/ab")).toBeNull();
    expect(resolveIn(mounts, "/deep")).toBeNull();
  });
  it("虛擬子目錄", () => {
    expect(virtualChildren(mounts, "/").sort()).toEqual(["a", "deep"]);
    expect(virtualChildren(mounts, "/deep")).toEqual(["b"]);
    expect(virtualChildren(mounts, "/a")).toEqual(["x"]);
  });
  it("fsmeta 工具", () => {
    expect(ancestors("/a/b")).toEqual(["/a/b", "/a", "/"]);
    expect(isHidden(".git", "/a/.git", [".*"])).toBe(true);
    expect(isHidden("x.TMP", "/a/x.TMP", ["*.tmp"])).toBe(true);
    expect(isHidden("b", "/a/b", ["/a/b"])).toBe(true);
    expect(isHidden("b", "/c/b", ["/a/b"])).toBe(false);
  });
});

describe("fs 路由", () => {
  it("掛載 CRUD 與路徑衝突", async () => {
    const h = await setup();
    expect(h.m1.status).toBe(201);
    expect(h.m1.json).toMatchObject({ mountPath: "/a", rootPath: "/data", storageName: "A", readonly: false });
    expect((await h.call("POST", "/api/admin/mounts", { mountPath: "/a/", storageId: h.a }, h.auth)).status).toBe(409);
    const p = await h.call("PATCH", `/api/admin/mounts/${h.m1.json.id}`, { readonly: true }, h.auth);
    expect(p.json.readonly).toBe(true);
    expect((await h.call("GET", "/api/admin/mounts", undefined, h.auth)).json.mounts).toHaveLength(2);
    expect((await h.call("GET", "/api/admin/mounts")).status).toBe(401);
    expect((await h.call("DELETE", `/api/admin/mounts/${h.m2.json.id}`, undefined, h.auth)).json.ok).toBe(true);
  });

  it("虛擬根目錄列出掛載點，掛載內列出檔案", async () => {
    const h = await setup();
    put("A", "/data/hello.txt", "hi");
    put("A", "/data/sub/x.bin", "xx");
    const root = await h.call("GET", "/api/fs/list?path=/", undefined, h.auth);
    expect(root.json.entries.map((e: any) => e.name).sort()).toEqual(["a", "deep"]);
    expect((await h.call("GET", "/api/fs/list?path=/deep", undefined, h.auth)).json.entries.map((e: any) => e.path)).toEqual(["/deep/b"]);
    const a = await h.call("GET", "/api/fs/list?path=/a", undefined, h.auth);
    expect(a.json.entries.map((e: any) => [e.name, e.path, e.isDir])).toEqual([
      ["hello.txt", "/a/hello.txt", false],
      ["sub", "/a/sub", true],
    ]);
    const g = await h.call("GET", "/api/fs/get?path=/a/hello.txt", undefined, h.auth);
    expect(g.json).toMatchObject({ size: 2, isDir: false, mime: "text/plain" });
    const d = await h.call("GET", "/api/fs/download?path=/a/hello.txt", undefined, h.auth);
    expect(d.text).toBe("hi");
    expect((await h.call("GET", "/api/fs/list?path=/nope", undefined, h.auth)).status).toBe(404);
    expect((await h.call("GET", "/api/fs/list?path=/a/../x", undefined, h.auth)).status).toBe(400);
  });

  it("匿名瀏覽依 fsPublicBrowse，寫入需權限", async () => {
    const h = await setup();
    expect((await h.call("GET", "/api/fs/list?path=/")).status).toBe(401);
    await h.call("PUT", "/api/admin/settings", { fsPublicBrowse: true }, h.auth);
    expect((await h.call("GET", "/api/fs/list?path=/")).status).toBe(200);
    expect((await h.call("POST", "/api/fs/mkdir", { path: "/a/new" })).status).toBe(401);
  });

  it("mkdir / rename / delete / 唯讀掛載", async () => {
    const h = await setup();
    put("A", "/data/f.txt", "1");
    expect((await h.call("POST", "/api/fs/mkdir", { path: "/a/d1" }, h.auth)).status).toBe(201);
    expect(memFsStores.get("A")!.get("/data/d1")).toBe("dir");
    const r = await h.call("POST", "/api/fs/rename", { path: "/a/f.txt", name: "g.txt" }, h.auth);
    expect(r.json.path).toBe("/a/g.txt");
    expect((await h.call("POST", "/api/fs/rename", { path: "/a/g.txt", name: "../x" }, h.auth)).status).toBe(400);
    expect((await h.call("POST", "/api/fs/delete", { paths: ["/a/g.txt", "/a/d1"] }, h.auth)).json.deleted).toBe(2);
    expect(memFsStores.get("A")!.has("/data/g.txt")).toBe(false);
    expect((await h.call("POST", "/api/fs/delete", { paths: ["/a"] }, h.auth)).status).toBe(400);
    await h.call("PATCH", `/api/admin/mounts/${h.m1.json.id}`, { readonly: true }, h.auth);
    const ro = await h.call("POST", "/api/fs/mkdir", { path: "/a/d2" }, h.auth);
    expect(ro.status).toBe(403);
    expect(ro.json.code ?? ro.json.error?.code).toBeDefined();
  });

  it("同儲存 copy/move 直接呼叫驅動", async () => {
    const h = await setup();
    put("A", "/data/src/f.txt", "abc");
    await h.call("POST", "/api/fs/mkdir", { path: "/a/dst" }, h.auth);
    const c = await h.call("POST", "/api/fs/copy", { paths: ["/a/src"], dst: "/a/dst" }, h.auth);
    expect(c.json).toMatchObject({ done: 1, queued: 0, taskId: null });
    expect(new TextDecoder().decode(memFsStores.get("A")!.get("/data/dst/src/f.txt") as Uint8Array)).toBe("abc");
    expect((await h.call("POST", "/api/fs/copy", { paths: ["/a/src"], dst: "/a/dst" }, h.auth)).status).toBe(409);
    expect((await h.call("POST", "/api/fs/move", { paths: ["/a/dst"], dst: "/a/dst/src" }, h.auth)).status).toBe(400);
    const m = await h.call("POST", "/api/fs/move", { paths: ["/a/src/f.txt"], dst: "/a" }, h.auth);
    expect(m.json.done).toBe(1);
    expect(memFsStores.get("A")!.has("/data/f.txt")).toBe(true);
    expect(memFsStores.get("A")!.has("/data/src/f.txt")).toBe(false);
  });

  it("跨儲存搬移建立 tasks，cron 分段完成並刪除來源", async () => {
    const h = await setup();
    put("A", "/data/dir/one.txt", "1");
    put("A", "/data/dir/sub/two.txt", "22");
    const m = await h.call("POST", "/api/fs/move", { paths: ["/a/dir"], dst: "/deep/b" }, h.auth);
    expect(m.status).toBe(202);
    expect(m.json.queued).toBe(1);
    const id = m.json.taskId;
    expect((await h.call("GET", `/api/admin/tasks/${id}`, undefined, h.auth)).json.status).toBe("pending");
    await tasksModule.cron!(h.ctx);
    const t = (await h.call("GET", `/api/admin/tasks/${id}`, undefined, h.auth)).json;
    expect(t.status).toBe("succeeded");
    expect(t.result).toEqual({ copied: 2, moved: true });
    expect(t.progress).toBe(t.total);
    const B = memFsStores.get("B")!;
    expect(new TextDecoder().decode(B.get("/dir/sub/two.txt") as Uint8Array)).toBe("22");
    expect(memFsStores.get("A")!.has("/data/dir")).toBe(false);
    expect((await h.call("GET", "/api/admin/tasks?kind=fs.transfer", undefined, h.auth)).json.tasks).toHaveLength(1);
    expect((await h.call("DELETE", `/api/admin/tasks/${id}`, undefined, h.auth)).json.ok).toBe(true);
  });

  it("驅動無原生 copy 時同儲存也走 tasks；失敗會記錄錯誤", async () => {
    const h = await setup();
    const c = await h.mk("C", { noCopy: true });
    await h.call("POST", "/api/admin/mounts", { mountPath: "/c", storageId: c }, h.auth);
    put("C", "/f.txt", "z");
    await h.call("POST", "/api/fs/mkdir", { path: "/c/d" }, h.auth);
    const r = await h.call("POST", "/api/fs/copy", { paths: ["/c/f.txt"], dst: "/c/d" }, h.auth);
    expect(r.json.queued).toBe(1);
    await tasksModule.cron!(h.ctx);
    expect((await h.call("GET", `/api/admin/tasks/${r.json.taskId}`, undefined, h.auth)).json.status).toBe("succeeded");
    expect(memFsStores.get("C")!.has("/d/f.txt")).toBe(true);
    // 來源消失 → 失敗
    const r2 = await h.call("POST", "/api/fs/copy", { paths: ["/c/f.txt"], dst: "/a" }, h.auth);
    memFsStores.get("C")!.delete("/f.txt");
    await tasksModule.cron!(h.ctx);
    const t2 = (await h.call("GET", `/api/admin/tasks/${r2.json.taskId}`, undefined, h.auth)).json;
    expect(t2.status).toBe("failed");
    expect(t2.error).toContain("來源不存在");
  });

  it("上傳（直傳工作階段 + 經後端 put）與分享", async () => {
    const h = await setup();
    const bytes = enc("hello world");
    const init = await h.call("POST", "/api/fs/upload/init", { path: "/a/up", filename: "中文.txt", size: bytes.byteLength }, h.auth);
    expect(init.status).toBe(201);
    const tok = { "x-upload-token": init.json.uploadToken };
    await h.call("PUT", `${init.json.actionBase}/put`, bytes, tok);
    expect((await h.call("POST", "/api/fs/upload/complete", { sessionId: init.json.sessionId }, { "x-upload-token": "bad" })).status).toBe(403);
    const done = await h.call("POST", "/api/fs/upload/complete", { sessionId: init.json.sessionId }, tok);
    expect(done.json.entry).toMatchObject({ path: "/a/up/中文.txt", size: 11 });
    expect(memFsStores.get("A")!.has("/data/up/中文.txt")).toBe(true);
    const p = await h.call("PUT", "/api/fs/upload/put?path=/deep/b/p.txt", enc("pp"), h.auth);
    expect(p.status).toBe(201);
    const s = await h.call("POST", "/api/fs/share", { path: "/a/up/中文.txt", share: { maxViews: 3 } }, h.auth);
    expect(s.status).toBe(201);
    expect(s.json.url).toMatch(/\/f\/[A-Za-z0-9_-]+$/);
    const row = await h.ctx.db.first<any>("SELECT * FROM shares WHERE slug = ?", [s.json.share.slug]);
    expect(row).toMatchObject({ storage_id: h.a, object_path: "/data/up/中文.txt", max_views: 3 });
  });
});

describe("fsmeta", () => {
  it("隱藏規則（apply_to_children）、目錄密碼與解鎖", async () => {
    const h = await setup();
    await h.call("PUT", "/api/admin/settings", { fsPublicBrowse: true }, h.auth);
    put("A", "/data/.secret", "s");
    put("A", "/data/ok.txt", "o");
    put("A", "/data/lock/in.txt", "i");
    put("A", "/data/lock/deeper/x.txt", "x");
    const hide = await h.call("POST", "/api/admin/fs-meta", { path: "/a", hidePatterns: [".*"], readmeMd: "# 說明" }, h.auth);
    expect(hide.status).toBe(201);
    const anonList = await h.call("GET", "/api/fs/list?path=/a");
    expect(anonList.json.entries.map((e: any) => e.name)).toEqual(["lock", "ok.txt"]);
    expect(anonList.json.readmeMd).toBe("# 說明");
    expect((await h.call("GET", "/api/fs/download?path=/a/.secret")).status).toBe(404);
    const adminList = await h.call("GET", "/api/fs/list?path=/a", undefined, h.auth);
    expect(adminList.json.entries.find((e: any) => e.name === ".secret").hidden).toBe(true);

    const pw = await h.call("POST", "/api/admin/fs-meta", { path: "/a/lock", password: "open", applyToChildren: true }, h.auth);
    expect(pw.json.hasPassword).toBe(true);
    const locked = await h.call("GET", "/api/fs/list?path=/a/lock/deeper");
    expect(locked.status).toBe(403);
    expect(JSON.stringify(locked.json)).toContain("password_required");
    expect((await h.call("GET", "/api/fs/meta?path=/a/lock/deeper")).json).toMatchObject({ passwordRequired: true, unlocked: false, passwordPath: "/a/lock" });
    expect((await h.call("POST", "/api/fs/unlock", { path: "/a/lock", password: "no" })).status).toBe(403);
    const un = await h.call("POST", "/api/fs/unlock", { path: "/a/lock/deeper", password: "open" });
    expect(un.json.path).toBe("/a/lock");
    const ok = await h.call("GET", "/api/fs/list?path=/a/lock/deeper", undefined, { "x-fs-token": un.json.token });
    expect(ok.status).toBe(200);
    expect((await h.call("GET", `/api/fs/download?path=/a/lock/in.txt&fsToken=${encodeURIComponent(un.json.token)}`)).text).toBe("i");

    // apply_to_children = false：只保護自身
    await h.call("PATCH", `/api/admin/fs-meta/${pw.json.id}`, { applyToChildren: false }, h.auth);
    expect((await h.call("GET", "/api/fs/list?path=/a/lock/deeper")).status).toBe(200);
    expect((await h.call("GET", "/api/fs/list?path=/a/lock")).status).toBe(403);
    // 移除密碼
    await h.call("PATCH", `/api/admin/fs-meta/${pw.json.id}`, { password: "" }, h.auth);
    expect((await h.call("GET", "/api/fs/list?path=/a/lock")).status).toBe(200);
    expect((await h.call("GET", "/api/admin/fs-meta", undefined, h.auth)).json.items).toHaveLength(2);
    expect((await h.call("DELETE", `/api/admin/fs-meta/${hide.json.id}`, undefined, h.auth)).json.ok).toBe(true);
  });
});

describe("tasks 服務", () => {
  it("createTask / updateProgress / finish / cancel", async () => {
    const h = await setup();
    const id = await createTask(h.ctx, "unknown.kind", { a: 1 }, { total: 5 });
    await updateProgress(h.ctx, id, { progress: 2 });
    expect((await getTask(h.ctx, id)).progress).toBe(2);
    const id2 = await createTask(h.ctx, "x", {});
    expect((await h.call("POST", `/api/admin/tasks/${id2}/cancel`, undefined, h.auth)).json.ok).toBe(true);
    expect((await h.call("POST", `/api/admin/tasks/${id2}/cancel`, undefined, h.auth)).status).toBe(400);
    await updateProgress(h.ctx, id2, { progress: 9 });
    expect((await getTask(h.ctx, id2)).progress).toBe(0);
    await tasksModule.cron!(h.ctx); // 沒有處理函式 → failed
    expect((await getTask(h.ctx, id)).status).toBe("failed");
    const id3 = await createTask(h.ctx, "x", {});
    await finish(h.ctx, id3, { result: { n: 1 } });
    expect(JSON.parse((await getTask(h.ctx, id3)).result!)).toEqual({ n: 1 });
    expect((await h.call("DELETE", `/api/admin/tasks/${id3}`, undefined, h.auth)).json.ok).toBe(true);
  });
});
