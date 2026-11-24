import { beforeEach, describe, expect, it } from "vitest";
import { makeApp } from "./helpers/app";
import { memFiles, memFsStores, memfsDriver } from "./helpers/memory-driver";
import { DRIVERS } from "../src/storage/registry";
import type { DriverDefinition } from "../src/storage/types";
import { renderUploadPath, sanitizeRelativePath, validateGroupId } from "../src/modules/uploads";
import { dedupeBatchClientPaths } from "../src/modules/fs";

/** 批次 clientPath 去重：同名跨子目錄不撞，後綴不與既有檔名撞 */
describe("dedupeBatchClientPaths", () => {
  const names = (xs: string[]) => {
    const files = xs.map((clientPath) => ({ clientPath }));
    dedupeBatchClientPaths(files);
    return files.map((f) => f.clientPath);
  };
  it("同名檔加 -2、-3 後綴", () => {
    expect(names(["a.jpg", "a.jpg", "a.jpg"])).toEqual(["a.jpg", "a-2.jpg", "a-3.jpg"]);
  });
  it("後綴不與既有同名檔撞", () => {
    expect(names(["a.jpg", "a-2.jpg", "a.jpg"])).toEqual(["a.jpg", "a-2.jpg", "a-3.jpg"]);
  });
  it("無副檔名加在尾端", () => {
    expect(names(["README", "README"])).toEqual(["README", "README-2"]);
  });
  it("沒有重複時不動", () => {
    expect(names(["a.jpg", "b.jpg"])).toEqual(["a.jpg", "b.jpg"]);
  });
});

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
beforeEach(() => {
  memFiles.clear();
  memFsStores.clear();
});

async function setup() {
  const h = await makeApp();
  const token = await h.login();
  const auth = { authorization: `Bearer ${token}` };
  const mem = (await h.call("POST", "/api/admin/storages", { name: "M", type: "memory", config: { label: "x", secretKey: "s3cret" } }, auth)).json.id as number;
  const mk = async (name: string, type: string) => (await h.call("POST", "/api/admin/storages", { name, type, config: { label: name } }, auth)).json.id as number;
  await h.call("POST", "/api/admin/mounts", { mountPath: "/a", storageId: await mk("A", "memfs"), rootPath: "/data" }, auth);
  await h.call("POST", "/api/admin/mounts", { mountPath: "/p", storageId: await mk("P", "memproxy") }, auth);
  return { ...h, auth, mem };
}

/** 分享流程完整上傳一檔（memory 驅動的 mem-direct 協定） */
async function shareUpload(h: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown>, bytes: Uint8Array) {
  const init = await h.call("POST", "/api/uploads", body, h.auth);
  expect(init.status).toBe(201);
  const { sessionId, uploadToken } = init.json;
  const put = await h.call("PUT", `/api/uploads/${sessionId}/action/put`, bytes, { "x-upload-token": uploadToken });
  expect(put.status).toBe(200);
  const done = await h.call("POST", `/api/uploads/${sessionId}/complete`, {}, { "x-upload-token": uploadToken });
  expect(done.status).toBe(200);
  return done.json;
}

describe("sanitizeRelativePath / validateGroupId / renderUploadPath", () => {
  it("相對路徑逐段清理；反斜線、. 與空段被處理", () => {
    expect(sanitizeRelativePath("photos/sub/a.txt")).toEqual(["photos", "sub", "a.txt"]);
    expect(sanitizeRelativePath("win\\sub\\a.txt")).toEqual(["win", "sub", "a.txt"]);
    expect(sanitizeRelativePath("/photos//./a.txt")).toEqual(["photos", "a.txt"]);
    expect(sanitizeRelativePath("")).toEqual([]);
  });
  it("拒絕 ..、超過 20 層、過長路徑", () => {
    expect(() => sanitizeRelativePath("../evil.txt")).toThrow("..");
    expect(() => sanitizeRelativePath("a/../../b.txt")).toThrow("..");
    expect(() => sanitizeRelativePath(Array.from({ length: 21 }, (_, i) => `d${i}`).join("/") + "/f.txt")).toThrow("太深");
  });
  it("groupId 只接受英數字、-、_（1–32 字元）", () => {
    expect(validateGroupId("grp-1_abc")).toBe("grp-1_abc");
    expect(validateGroupId(undefined)).toBeUndefined();
    expect(() => validateGroupId("bad id!")).toThrow("groupId");
    expect(() => validateGroupId("x".repeat(33))).toThrow("groupId");
  });
  it("renderUploadPath 可覆寫 {rand}，同 rand 落在同一目錄", () => {
    const a = renderUploadPath("/{yyyy}/{mm}/{dd}/{rand}/{name}", "a.txt", new Date("2026-11-23T00:00:00Z"), "grp1");
    const b = renderUploadPath("/{yyyy}/{mm}/{dd}/{rand}/{name}", "b.txt", new Date("2026-11-23T00:00:00Z"), "grp1");
    expect(a).toBe("/2026/11/23/grp1/a.txt");
    expect(b).toBe("/2026/11/23/grp1/b.txt");
  });
});

describe("分享流程的文件夾上傳", () => {
  it("相對路徑併入儲存路徑，分享檔名仍為 basename", async () => {
    const h = await setup();
    const done = await shareUpload(h, { storageId: h.mem, filename: "a.txt", size: 5, relativePath: "photos/sub/a.txt", groupId: "grp1" }, new Uint8Array([1, 2, 3, 4, 5]));
    expect(done.share.filename).toBe("a.txt");
    expect(done.url).toMatch(/^http:\/\/local\/f\//);
    const keys = [...memFiles.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^\/\d{4}\/\d{2}\/\d{2}\/grp1\/photos\/sub\/a\.txt$/);
  });

  it("同 groupId 落在同一目錄；不同 groupId 目錄不同", async () => {
    const h = await setup();
    const dirOf = (k: string) => k.slice(0, k.lastIndexOf("/"));
    await shareUpload(h, { storageId: h.mem, filename: "a.txt", size: 1, relativePath: "f/a.txt", groupId: "same" }, new Uint8Array([1]));
    await shareUpload(h, { storageId: h.mem, filename: "b.txt", size: 1, relativePath: "f/sub/b.txt", groupId: "same" }, new Uint8Array([2]));
    await shareUpload(h, { storageId: h.mem, filename: "c.txt", size: 1, relativePath: "f/c.txt", groupId: "other" }, new Uint8Array([3]));
    const keys = [...memFiles.keys()];
    expect(keys).toHaveLength(3);
    const [k1, k2, k3] = keys;
    expect(dirOf(k1).replace(/\/f$/, "")).toBe(dirOf(k2).replace(/\/f\/sub$/, ""));
    expect(dirOf(k1)).not.toBe(dirOf(k3));
  });

  it("未填 relativePath 時行為不變（單一檔案）", async () => {
    const h = await setup();
    await shareUpload(h, { storageId: h.mem, filename: "solo.txt", size: 1 }, new Uint8Array([9]));
    expect([...memFiles.keys()][0]).toMatch(/^\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9]+\/solo\.txt$/);
  });

  it("非法 relativePath / groupId 回 400", async () => {
    const h = await setup();
    const bad1 = await h.call("POST", "/api/uploads", { storageId: h.mem, filename: "a.txt", size: 1, relativePath: "../a.txt" }, h.auth);
    expect(bad1.status).toBe(400);
    const bad2 = await h.call("POST", "/api/uploads", { storageId: h.mem, filename: "a.txt", size: 1, groupId: "bad id!" }, h.auth);
    expect(bad2.status).toBe(400);
  });
});

describe("檔案總管的巢狀目錄上傳（文件夾上傳的後端路徑）", () => {
  it("直傳：不存在的子目錄可直接上傳，list 看得到", async () => {
    const h = await setup();
    const init = await h.call("POST", "/api/fs/upload/init", { path: "/a/photos/sub", filename: "b.txt", size: 3 }, h.auth);
    expect(init.status).toBe(201);
    expect(init.json.protocol).toBe("mem-direct");
    const put = await h.call("PUT", `/api/uploads/${init.json.sessionId}/action/put`, new Uint8Array([1, 2, 3]), { "x-upload-token": init.json.uploadToken });
    expect(put.status).toBe(200);
    const done = await h.call("POST", "/api/fs/upload/complete", { sessionId: init.json.sessionId, body: {} }, { ...h.auth, "x-upload-token": init.json.uploadToken });
    expect(done.status).toBe(200);
    expect(done.json.entry.path).toBe("/a/photos/sub/b.txt");
    const list = await h.call("GET", "/api/fs/list?path=/a/photos/sub", undefined, h.auth);
    expect(list.json.entries.map((e: any) => e.name)).toEqual(["b.txt"]);
  });

  it("proxy（WebDAV／本機／GitHub 類渠道）：巢狀目錄 PUT 建好父目錄", async () => {
    const h = await setup();
    const init = await h.call("POST", "/api/fs/upload/init", { path: "/p/photos", filename: "c.txt", size: 3 }, h.auth);
    expect(init.status).toBe(201);
    expect(init.json.protocol).toBe("proxy");
    const put = await h.call("PUT", init.json.putUrl, new Uint8Array([7, 8, 9]), h.auth);
    expect(put.status).toBe(201);
    const list = await h.call("GET", "/api/fs/list?path=/p/photos", undefined, h.auth);
    expect(list.json.entries.map((e: any) => e.name)).toEqual(["c.txt"]);
  });

  it("init-batch：非 xet 儲存回 batch_unsupported（前端退回逐檔上傳）", async () => {
    const h = await setup();
    const r = await h.call("POST", "/api/fs/upload/init-batch", { path: "/a/photos", files: [{ relativePath: "a.txt", size: 1 }, { relativePath: "sub/b.txt", size: 2 }] }, h.auth);
    expect(r.status).toBe(400);
    expect(r.json.error?.code).toBe("batch_unsupported");
  });

  it("init-batch：空清單與超過上限回 400", async () => {
    const h = await setup();
    const empty = await h.call("POST", "/api/fs/upload/init-batch", { path: "/a/photos", files: [] }, h.auth);
    expect(empty.status).toBe(400);
    const tooMany = await h.call("POST", "/api/fs/upload/init-batch", { path: "/a/photos", files: Array.from({ length: 1001 }, (_, i) => ({ relativePath: `f${i}.txt`, size: 1 })) }, h.auth);
    expect(tooMany.status).toBe(400);
    expect(tooMany.json.error?.code).toBe("too_many_files");
  });
});
