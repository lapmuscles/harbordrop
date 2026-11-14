import { beforeEach, describe, expect, it } from "vitest";
import { makeApp } from "./helpers/app";
import { memFsStores, memfsDriver } from "./helpers/memory-driver";
import { DRIVERS } from "../src/storage/registry";
import { davPathToVpath, destinationToVpath, hrefFor, parseRange, sliceStream } from "../src/modules/webdav/xml";

if (!DRIVERS.includes(memfsDriver)) DRIVERS.push(memfsDriver);
beforeEach(() => memFsStores.clear());

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (s: string) => btoa(String.fromCharCode(...enc(s)));
const basic = (u: string, p: string) => ({ authorization: `Basic ${b64(`${u}:${p}`)}` });
const ADMIN = basic("admin", "pass-1234");

async function setup() {
  const h = await makeApp();
  const auth = { authorization: `Bearer ${await h.login()}` };
  const mk = async (label: string, extra: Record<string, unknown> = {}) =>
    (await h.call("POST", "/api/admin/storages", { name: label, type: "memfs", config: { label, ...extra } }, auth)).json.id as number;
  const a = await mk("A");
  const b = await mk("B");
  const m1 = (await h.call("POST", "/api/admin/mounts", { mountPath: "/a", storageId: a, rootPath: "/" }, auth)).json;
  const m2 = (await h.call("POST", "/api/admin/mounts", { mountPath: "/deep/b", storageId: b }, auth)).json;
  const dav = (method: string, path: string, body?: string | Uint8Array, headers: Record<string, string> = ADMIN) =>
    h.app.fetch(new Request(`http://local${path}`, { method, headers, body: typeof body === "string" ? enc(body) : (body as BodyInit | undefined) }));
  const apiKey = async (permissions: string[], acl?: unknown) =>
    (await h.call("POST", "/api/admin/api-keys", { name: "k", permissions, acl }, auth)).json.key as string;
  return { ...h, auth, a, b, m1, m2, dav, apiKey };
}

const hrefs = (xml: string) => [...xml.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]);

describe("WebDAV 工具函式", () => {
  it("路徑編碼與解碼（中文）", () => {
    expect(hrefFor("/a/中文 資料夾", true)).toBe("/dav/a/%E4%B8%AD%E6%96%87%20%E8%B3%87%E6%96%99%E5%A4%BE/");
    expect(davPathToVpath("/dav/a/%E4%B8%AD%E6%96%87")).toBe("/a/中文");
    expect(davPathToVpath("/dav/")).toBe("/");
    expect(davPathToVpath("/dav/a/%2e%2e/x")).toBeNull();
    expect(davPathToVpath("/dav/a/%2Fx")).toBeNull();
    expect(davPathToVpath("/davx")).toBeNull();
    expect(destinationToVpath("http://host/dav/a/b.txt")).toBe("/a/b.txt");
    expect(destinationToVpath("http://host/other/b.txt")).toBeNull();
  });
  it("Range 解析與切片", async () => {
    expect(parseRange("bytes=0-3", 10)).toEqual({ start: 0, end: 3 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=20-", 10)).toBe("invalid");
    expect(parseRange(undefined, 10)).toBeNull();
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc("abc"));
        c.enqueue(enc("defg"));
        c.enqueue(enc("hij"));
        c.close();
      },
    });
    expect(await new Response(sliceStream(src, 2, 7)).text()).toBe("cdefgh");
  });
});

describe("WebDAV 伺服器", () => {
  it("OPTIONS 不需驗證，宣告 DAV 1,2", async () => {
    const h = await setup();
    const r = await h.dav("OPTIONS", "/dav/", undefined, {});
    expect(r.status).toBe(200);
    expect(r.headers.get("dav")).toContain("2");
    expect(r.headers.get("allow")).toContain("PROPFIND");
  });

  it("未驗證回 401 與 WWW-Authenticate；錯誤密碼 401", async () => {
    const h = await setup();
    const r = await h.dav("PROPFIND", "/dav/", undefined, { depth: "0" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/^Basic/);
    expect((await h.dav("PROPFIND", "/dav/", undefined, { ...basic("admin", "wrong"), depth: "0" })).status).toBe(401);
  });

  it("litmus 風格：PUT → PROPFIND → GET（Range）→ MOVE → COPY → DELETE", async () => {
    const h = await setup();
    // MKCOL（中文資料夾）
    expect((await h.dav("MKCOL", "/dav/a/%E6%96%87%E4%BB%B6")).status).toBe(201);
    expect((await h.dav("MKCOL", "/dav/a/%E6%96%87%E4%BB%B6")).status).toBe(405);
    expect((await h.dav("MKCOL", "/dav/a/none/sub")).status).toBe(409);
    // PUT
    const put = await h.dav("PUT", "/dav/a/%E6%96%87%E4%BB%B6/hello.txt", "0123456789", { ...ADMIN, "content-type": "text/plain" });
    expect(put.status).toBe(201);
    expect((await h.dav("PUT", "/dav/a/%E6%96%87%E4%BB%B6/hello.txt", "0123456789abc")).status).toBe(204);
    expect((await h.dav("PUT", "/dav/a/missing/x.txt", "x")).status).toBe(409);
    // PROPFIND Depth 0 / 1
    const root = await h.dav("PROPFIND", "/dav/", undefined, { ...ADMIN, depth: "1" });
    expect(root.status).toBe(207);
    const rx = await root.text();
    expect(rx).toContain('xmlns:D="DAV:"');
    expect(hrefs(rx).sort()).toEqual(["/dav/", "/dav/a/", "/dav/deep/"]);
    const d0 = await (await h.dav("PROPFIND", "/dav/a/%E6%96%87%E4%BB%B6", undefined, { ...ADMIN, depth: "0" })).text();
    expect(hrefs(d0)).toEqual(["/dav/a/%E6%96%87%E4%BB%B6/"]);
    expect(d0).toContain("<D:collection/>");
    expect(d0).toContain("<D:displayname>文件</D:displayname>");
    const d1 = await (await h.dav("PROPFIND", "/dav/a/%E6%96%87%E4%BB%B6/", undefined, { ...ADMIN, depth: "1" })).text();
    expect(hrefs(d1)).toContain("/dav/a/%E6%96%87%E4%BB%B6/hello.txt");
    expect(d1).toContain("<D:getcontentlength>13</D:getcontentlength>");
    expect((await h.dav("PROPFIND", "/dav/a/nope", undefined, { ...ADMIN, depth: "0" })).status).toBe(404);
    // GET / HEAD / Range
    const g = await h.dav("GET", "/dav/a/%E6%96%87%E4%BB%B6/hello.txt");
    expect(g.status).toBe(200);
    expect(await g.text()).toBe("0123456789abc");
    const hd = await h.dav("HEAD", "/dav/a/%E6%96%87%E4%BB%B6/hello.txt");
    expect(hd.headers.get("content-length")).toBe("13");
    const rg = await h.dav("GET", "/dav/a/%E6%96%87%E4%BB%B6/hello.txt", undefined, { ...ADMIN, range: "bytes=2-5" });
    expect(rg.status).toBe(206);
    expect(rg.headers.get("content-range")).toBe("bytes 2-5/13");
    expect(await rg.text()).toBe("2345");
    expect((await h.dav("GET", "/dav/a/%E6%96%87%E4%BB%B6/hello.txt", undefined, { ...ADMIN, range: "bytes=50-" })).status).toBe(416);
    // MOVE（同儲存）
    const mv = await h.dav("MOVE", "/dav/a/%E6%96%87%E4%BB%B6/hello.txt", undefined, { ...ADMIN, destination: "http://local/dav/a/%E6%96%87%E4%BB%B6/moved.txt" });
    expect(mv.status).toBe(201);
    expect(memFsStores.get("A")!.has("/文件/moved.txt")).toBe(true);
    expect(memFsStores.get("A")!.has("/文件/hello.txt")).toBe(false);
    // COPY 跨儲存（檔案同步複製）＋ Overwrite
    const cp = await h.dav("COPY", "/dav/a/%E6%96%87%E4%BB%B6/moved.txt", undefined, { ...ADMIN, destination: "/dav/deep/b/copy.txt" });
    expect(cp.status).toBe(201);
    expect(new TextDecoder().decode(memFsStores.get("B")!.get("/copy.txt") as Uint8Array)).toBe("0123456789abc");
    const cp2 = await h.dav("COPY", "/dav/a/%E6%96%87%E4%BB%B6/moved.txt", undefined, { ...ADMIN, destination: "/dav/deep/b/copy.txt", overwrite: "F" });
    expect(cp2.status).toBe(412);
    const cp3 = await h.dav("COPY", "/dav/a/%E6%96%87%E4%BB%B6/moved.txt", undefined, { ...ADMIN, destination: "/dav/deep/b/copy.txt", overwrite: "T" });
    expect(cp3.status).toBe(204);
    // DELETE
    expect((await h.dav("DELETE", "/dav/a/%E6%96%87%E4%BB%B6")).status).toBe(204);
    expect((await h.dav("DELETE", "/dav/a/%E6%96%87%E4%BB%B6")).status).toBe(404);
    expect((await h.dav("DELETE", "/dav/a")).status).toBe(403);
  });

  it("LOCK / UNLOCK 假鎖與 PROPPATCH", async () => {
    const h = await setup();
    const body = `<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>me</D:href></D:owner></D:lockinfo>`;
    const l = await h.dav("LOCK", "/dav/a/x.txt", body, { ...ADMIN, timeout: "Second-600" });
    expect(l.status).toBe(200);
    expect(l.headers.get("lock-token")).toMatch(/^<opaquelocktoken:/);
    const lx = await l.text();
    expect(lx).toContain("Second-600");
    expect(lx).toContain("<D:href>me</D:href>");
    expect((await h.dav("UNLOCK", "/dav/a/x.txt", undefined, { ...ADMIN, "lock-token": l.headers.get("lock-token")! })).status).toBe(204);
    const pp = await h.dav(
      "PROPPATCH",
      "/dav/a",
      `<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:"><D:set><D:prop><Z:Win32LastModifiedTime>x</Z:Win32LastModifiedTime></D:prop></D:set></D:propertyupdate>`,
    );
    expect(pp.status).toBe(207);
    expect(await pp.text()).toContain("Win32LastModifiedTime");
  });

  it("API 金鑰作為密碼：需 webdav 權限、ACL 路徑與寫入權限", async () => {
    const h = await setup();
    const none = await h.apiKey(["fs.read"]);
    expect((await h.dav("PROPFIND", "/dav/", undefined, { ...basic("x", none), depth: "0" })).status).toBe(403);
    const ro = await h.apiKey(["webdav"], [{ pathPrefix: "/a", perms: ["read"] }]);
    const RO = basic("anyone", ro);
    expect((await h.dav("PROPFIND", "/dav/a", undefined, { ...RO, depth: "1" })).status).toBe(207);
    expect((await h.dav("PROPFIND", "/dav/deep/b", undefined, { ...RO, depth: "1" })).status).toBe(403);
    expect((await h.dav("PUT", "/dav/a/f.txt", "x", RO)).status).toBe(403);
    // 根目錄列表只顯示可讀的掛載
    const rootX = await h.dav("PROPFIND", "/dav/", undefined, { ...RO, depth: "1" });
    expect(rootX.status).toBe(207);
    expect(hrefs(await rootX.text()).sort()).toEqual(["/dav/", "/dav/a/"]);
    expect((await h.dav("PROPFIND", "/dav/deep", undefined, { ...RO, depth: "0" })).status).toBe(403);
    const rw = await h.apiKey(["webdav", "fs.write", "fs.delete"]);
    const RW = basic("u", rw);
    expect((await h.dav("PUT", "/dav/a/f.txt", "x", RW)).status).toBe(201);
    expect((await h.dav("DELETE", "/dav/a/f.txt", undefined, RW)).status).toBe(204);
    expect((await h.dav("PROPFIND", "/dav/", undefined, { ...basic("u", "hd_" + "0".repeat(32)), depth: "0" })).status).toBe(401);
  });

  it("fsmeta 隱藏規則與密碼目錄（非管理員）", async () => {
    const h = await setup();
    await h.dav("PUT", "/dav/a/.secret", "s");
    await h.dav("PUT", "/dav/a/ok.txt", "o");
    await h.dav("MKCOL", "/dav/a/locked");
    await h.call("POST", "/api/admin/fs-meta", { path: "/a", hidePatterns: [".*"] }, h.auth);
    await h.call("POST", "/api/admin/fs-meta", { path: "/a/locked", password: "pw" }, h.auth);
    const K = basic("u", await h.apiKey(["webdav"]));
    const x = await (await h.dav("PROPFIND", "/dav/a", undefined, { ...K, depth: "1" })).text();
    expect(hrefs(x)).toContain("/dav/a/ok.txt");
    expect(hrefs(x)).not.toContain("/dav/a/.secret");
    expect((await h.dav("GET", "/dav/a/.secret", undefined, K)).status).toBe(404);
    expect((await h.dav("PROPFIND", "/dav/a/locked", undefined, { ...K, depth: "0" })).status).toBe(403);
    // 管理員看得到
    expect(hrefs(await (await h.dav("PROPFIND", "/dav/a", undefined, { ...ADMIN, depth: "1" })).text())).toContain("/dav/a/.secret");
  });

  it("超過上傳上限回 413 與清楚訊息", async () => {
    const h = await setup();
    await h.call("PUT", "/api/admin/settings", { webdavMaxUploadBytes: 5 }, h.auth);
    const r = await h.dav("PUT", "/dav/a/big.bin", "0123456789", { ...ADMIN, "content-length": "10" });
    expect(r.status).toBe(413);
    expect(await r.text()).toContain("上傳上限");
    // 沒有 Content-Length（串流）也會被擋
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc("0123456789"));
        c.close();
      },
    });
    const r2 = await h.app.fetch(new Request("http://local/dav/a/big2.bin", { method: "PUT", headers: ADMIN, body: stream, duplex: "half" } as RequestInit));
    expect(r2.status).toBe(413);
  });

  it("唯讀掛載拒絕寫入；跨儲存資料夾 COPY 建立背景工作", async () => {
    const h = await setup();
    await h.dav("MKCOL", "/dav/a/dir");
    await h.dav("PUT", "/dav/a/dir/f.txt", "f");
    const cp = await h.dav("COPY", "/dav/a/dir", undefined, { ...ADMIN, destination: "/dav/deep/b/dir" });
    expect(cp.status).toBe(202);
    const tasks = (await h.call("GET", "/api/admin/tasks?kind=fs.transfer", undefined, h.auth)).json.tasks;
    expect(tasks.length).toBe(1);
    await h.call("PATCH", `/api/admin/mounts/${h.m1.id}`, { readonly: true }, h.auth);
    expect((await h.dav("PUT", "/dav/a/z.txt", "z")).status).toBe(403);
  });
});
