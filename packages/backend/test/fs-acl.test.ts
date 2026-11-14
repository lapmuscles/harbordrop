import { beforeEach, describe, expect, it } from "vitest";
import { makeApp } from "./helpers/app";
import { memFsStores, memfsDriver } from "./helpers/memory-driver";
import { DRIVERS } from "../src/storage/registry";
import { isHiddenPath } from "../src/modules/fsmeta/service";

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
  const sid = (await h.call("POST", "/api/admin/storages", { name: "A", type: "memfs", config: { label: "A" } }, auth)).json.id as number;
  const mount = (await h.call("POST", "/api/admin/mounts", { mountPath: "/a", storageId: sid, rootPath: "/data" }, auth)).json;
  put("A", "/data/pub/x.txt", "x");
  put("A", "/data/other.txt", "o");
  put("A", "/data/secret/deep/y.txt", "y");
  const key = async (acl: unknown[]) => {
    const k = await h.call("POST", "/api/admin/api-keys", { name: "k", permissions: ["fs.read", "fs.write"] }, auth);
    expect((await h.call("PUT", `/api/admin/api-keys/${k.json.id}/acl`, acl, auth)).status).toBe(200);
    return { "x-api-key": k.json.key as string };
  };
  return { ...h, auth, sid, mountId: mount.id as number, key };
}

describe("fs ACL：can() 的 path 為虛擬路徑", () => {
  it("pathPrefix 以虛擬路徑比對（不是儲存內路徑）", async () => {
    const h = await setup();
    const k = await h.key([{ pathPrefix: "/a/pub", perms: ["read"] }]);
    expect((await h.call("GET", "/api/fs/download?path=/a/pub/x.txt", undefined, k)).text).toBe("x");
    expect((await h.call("GET", "/api/fs/list?path=/a/pub", undefined, k)).status).toBe(200);
    expect((await h.call("GET", "/api/fs/get?path=/a/pub/x.txt", undefined, k)).status).toBe(200);
    expect((await h.call("GET", "/api/fs/download?path=/a/other.txt", undefined, k)).status).toBe(403);
    expect((await h.call("GET", "/api/fs/list?path=/a", undefined, k)).status).toBe(403);
    // read 不含 write
    expect((await h.call("POST", "/api/fs/mkdir", { path: "/a/pub/new" }, k)).status).toBe(403);

    // 儲存內路徑（/data/pub）不應被當成虛擬路徑授權
    const k2 = await h.key([{ pathPrefix: "/data/pub", perms: ["read"] }]);
    expect((await h.call("GET", "/api/fs/download?path=/a/pub/x.txt", undefined, k2)).status).toBe(403);
  });

  it("搭配 storageId／mountId 限定時仍用虛擬路徑", async () => {
    const h = await setup();
    const km = await h.key([{ mountId: h.mountId, pathPrefix: "/a/pub", perms: ["read"] }]);
    expect((await h.call("GET", "/api/fs/download?path=/a/pub/x.txt", undefined, km)).text).toBe("x");
    const ks = await h.key([{ storageId: h.sid, pathPrefix: "/a", perms: ["*"] }]);
    expect((await h.call("GET", "/api/fs/download?path=/a/other.txt", undefined, ks)).text).toBe("o");
    const other = (await h.call("POST", "/api/admin/mounts", { mountPath: "/b", storageId: h.sid, rootPath: "/data" }, h.auth)).json.id as number;
    const wrong = await h.key([{ mountId: other, pathPrefix: "/", perms: ["*"] }]);
    expect((await h.call("GET", "/api/fs/download?path=/b/pub/x.txt", undefined, wrong)).text).toBe("x");
    expect((await h.call("GET", "/api/fs/download?path=/a/pub/x.txt", undefined, wrong)).status).toBe(403);
  });
});

describe("fsmeta 隱藏規則檢查所有祖先", () => {
  it("祖先資料夾被隱藏時，list／get／download 都回 404（管理員可見）", async () => {
    const h = await setup();
    await h.call("PUT", "/api/admin/settings", { fsPublicBrowse: true }, h.auth);
    expect((await h.call("POST", "/api/admin/fs-meta", { path: "/a", hidePatterns: ["secret"], applyToChildren: false }, h.auth)).status).toBe(201);
    expect((await h.call("GET", "/api/fs/list?path=/a")).json.entries.map((e: any) => e.name).sort()).toEqual(["other.txt", "pub"]);
    expect((await h.call("GET", "/api/fs/list?path=/a/secret")).status).toBe(404);
    expect((await h.call("GET", "/api/fs/list?path=/a/secret/deep")).status).toBe(404);
    expect((await h.call("GET", "/api/fs/get?path=/a/secret/deep/y.txt")).status).toBe(404);
    expect((await h.call("GET", "/api/fs/download?path=/a/secret/deep/y.txt")).status).toBe(404);
    expect((await h.call("GET", "/api/fs/download?path=/a/secret/deep/y.txt", undefined, h.auth)).text).toBe("y");
    expect((await h.call("GET", "/api/fs/download?path=/a/pub/x.txt")).text).toBe("x");
  });

  it("isHiddenPath：含 / 的規則、apply_to_children", async () => {
    const h = await setup();
    await h.call("POST", "/api/admin/fs-meta", { path: "/", hidePatterns: ["/a/pub"], applyToChildren: true }, h.auth);
    await h.call("POST", "/api/admin/fs-meta", { path: "/a/secret", hidePatterns: ["*.tmp"], applyToChildren: true }, h.auth);
    expect(await isHiddenPath(h.ctx, "/a/pub/x.txt")).toBe(true);
    expect(await isHiddenPath(h.ctx, "/a/other.txt")).toBe(false);
    expect(await isHiddenPath(h.ctx, "/a/secret/deep/z.tmp")).toBe(true);
    expect(await isHiddenPath(h.ctx, "/a/secret/deep.tmp/z.txt")).toBe(true);
    expect(await isHiddenPath(h.ctx, "/a/secret/deep/y.txt")).toBe(false);
    expect(await isHiddenPath(h.ctx, "/")).toBe(false);
  });
});
