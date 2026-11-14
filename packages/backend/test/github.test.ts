import { describe, expect, it } from "vitest";
import { bytesToBase64, githubDriver } from "../src/storage/drivers/github";

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };
const TOKEN = "ghp_SECRET";
const MiB = 1024 * 1024;

function make(handler: (c: Call) => Response | undefined, platform: "node" | "workers" = "node", cfg: Record<string, any> = {}) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return handler(c) ?? Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof globalThis.fetch;
  const d = githubDriver.create({ owner: "me", repo: "files", branch: "main", token: TOKEN, root: "/store", ...cfg }, { platform, fetch });
  return { d, calls };
}

const C = "https://api.github.com/repos/me/files/contents/store";

describe("GitHub 驅動", () => {
  it("list：Contents API 陣列 → 項目（含 ref 與 Bearer 權杖）", async () => {
    const { d, calls } = make((c) =>
      c.url === `${C}/docs?ref=main`
        ? Response.json([
            { type: "file", name: "a.md", path: "store/docs/a.md", sha: "s1", size: 3 },
            { type: "dir", name: "img", path: "store/docs/img", sha: "s2", size: 0 },
            { type: "submodule", name: "x", path: "store/docs/x", sha: "s3", size: 0 },
          ])
        : undefined,
    );
    const r = await d.list!("/docs");
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(r.entries).toEqual([
      expect.objectContaining({ name: "img", path: "/docs/img", isDir: true }),
      expect.objectContaining({ name: "a.md", path: "/docs/a.md", isDir: false, size: 3, etag: "s1", mime: "text/markdown" }),
    ]);
  });

  it("stat：404 → null；中文路徑逐段編碼", async () => {
    const { d, calls } = make((c) => (c.url.includes("%E4%B8%AD") ? Response.json({ type: "file", name: "中.txt", path: "store/中.txt", sha: "abc", size: 9 }) : undefined));
    expect(await d.stat("/none")).toBeNull();
    expect(await d.stat("/中.txt")).toMatchObject({ size: 9, etag: "abc" });
    expect(calls[1].url).toBe(`${C}/%E4%B8%AD.txt?ref=main`);
  });

  it("download：raw 媒體型別、轉送 Range", async () => {
    const { d, calls } = make(() => new Response("ell", { status: 206, headers: { "content-range": "bytes 1-3/5", "content-length": "3" } }));
    const t = await d.download("/a.txt", { request: new Request("http://h", { headers: { range: "bytes=1-3" } }) });
    expect(calls[0].headers.accept).toBe("application/vnd.github.raw+json");
    expect(calls[0].headers.range).toBe("bytes=1-3");
    if (t.kind !== "response") throw new Error();
    expect(t.response.status).toBe(206);
    expect(await t.response.text()).toBe("ell");
  });

  it("put 新檔：不帶 sha；覆寫：帶既有 sha", async () => {
    let exists = false;
    const { d, calls } = make((c) => {
      if (c.method === "GET") return exists ? Response.json({ type: "file", name: "f.bin", path: "store/f.bin", sha: "old", size: 2 }) : undefined;
      if (c.method === "PUT") return Response.json({ content: { type: "file", name: "f.bin", path: "store/f.bin", sha: "new", size: 3 } }, { status: exists ? 200 : 201 });
    });
    const e = await d.put!("/f.bin", new Uint8Array([1, 2, 3]), { size: 3 });
    const put1 = calls.find((c) => c.method === "PUT")!;
    expect(put1.url).toBe(C + "/f.bin");
    expect(put1.body).toEqual({ message: expect.stringContaining("上傳"), content: "AQID", branch: "main" });
    expect(e).toMatchObject({ path: "/f.bin", size: 3, etag: "new" });

    exists = true;
    calls.length = 0;
    await d.put!("/f.bin", new ReadableStream({ start: (ctl) => (ctl.enqueue(new Uint8Array([9])), ctl.close()) }), { size: 1 });
    const put2 = calls.find((c) => c.method === "PUT")!;
    expect(put2.body.sha).toBe("old");
    expect(put2.body.content).toBe("CQ==");
  });

  it("put：sha 過期（409）時重新取得後重試", async () => {
    let gets = 0;
    let puts = 0;
    const { d } = make((c) => {
      if (c.method === "GET") return Response.json({ type: "file", name: "f", path: "store/f", sha: gets++ === 0 ? "stale" : "fresh", size: 1 });
      if (c.method === "PUT") return puts++ === 0 ? Response.json({ message: "sha mismatch" }, { status: 409 }) : Response.json({ content: { type: "file", name: "f", path: "store/f", sha: c.body.sha + "2", size: 1 } });
    });
    const e = await d.put!("/f", new Uint8Array(1), { size: 1 });
    expect(e.etag).toBe("fresh2");
  });

  it(">100MB 清楚報錯；Workers 上限 25MB", async () => {
    const { d, calls } = make(() => undefined);
    expect(d.capabilities.maxProxyUploadBytes).toBe(100 * MiB);
    await expect(d.put!("/big", new Uint8Array(1), { size: 101 * MiB })).rejects.toMatchObject({ status: 413, message: expect.stringContaining("100 MB") });
    expect(calls).toHaveLength(0);
    const w = make(() => undefined, "workers");
    await expect(w.d.put!("/mid", new Uint8Array(1), { size: 30 * MiB })).rejects.toMatchObject({ status: 413, message: expect.stringContaining("Workers") });
  });

  it("delete：檔案帶 sha；資料夾遞迴逐檔刪除；404 忽略", async () => {
    const { d, calls } = make((c) => {
      if (c.method === "GET" && c.url === `${C}/dir?ref=main`)
        return Response.json([
          { type: "file", name: "a", path: "store/dir/a", sha: "sa", size: 1 },
          { type: "dir", name: "sub", path: "store/dir/sub", sha: "x", size: 0 },
        ]);
      if (c.method === "GET" && c.url === `${C}/dir/sub?ref=main`) return Response.json([{ type: "file", name: "b", path: "store/dir/sub/b", sha: "sb", size: 1 }]);
      if (c.method === "GET" && c.url === `${C}/one.txt?ref=main`) return Response.json({ type: "file", name: "one.txt", path: "store/one.txt", sha: "s1", size: 1 });
      if (c.method === "DELETE") return Response.json({});
    });
    await d.delete!(["/one.txt", "/dir", "/missing"]);
    const dels = calls.filter((c) => c.method === "DELETE");
    expect(dels.map((c) => [c.url.replace(C, ""), c.body.sha, c.body.branch])).toEqual([
      ["/one.txt", "s1", "main"],
      ["/dir/a", "sa", "main"],
      ["/dir/sub/b", "sb", "main"],
    ]);
  });

  it("錯誤訊息與 testConnection；權杖不外洩於能力資訊", async () => {
    const bad = make(() => Response.json({ message: "Bad credentials" }, { status: 401 }));
    await expect(bad.d.list!("/")).rejects.toThrow(/權杖無效/);
    expect(await bad.d.testConnection()).toMatchObject({ ok: false });
    const ok = make((c) =>
      c.url.endsWith("/repos/me/files") ? Response.json({ full_name: "me/files", permissions: { push: true } }) : c.url.includes("/branches/main") ? Response.json({ name: "main" }) : undefined,
    );
    expect(await ok.d.testConnection()).toMatchObject({ ok: true, message: expect.stringContaining("me/files") });
    expect(JSON.stringify(ok.d.capabilities)).not.toContain(TOKEN);
    expect(d_mkdir()).toBe(false);
    function d_mkdir() {
      return ok.d.capabilities.mkdir;
    }
    expect(bytesToBase64(new TextEncoder().encode("中"))).toBe("5Lit");
    await expect(ok.d.stat("/../x")).rejects.toThrow();
  });
});

describe("GitHub 驅動：超過 1000 筆改用 Git Trees API", () => {
  it("Contents 回傳 1000 筆時，逐層走 Trees API 取得完整列表", async () => {
    const G = "https://api.github.com/repos/me/files";
    const big = Array.from({ length: 1000 }, (_, i) => ({ type: "file", name: `f${i}`, path: `store/big/f${i}`, sha: `c${i}`, size: 1 }));
    const treeItems = [
      ...Array.from({ length: 1500 }, (_, i) => ({ path: `f${i}`, type: "blob", sha: `b${i}`, size: i })),
      { path: "sub", type: "tree", sha: "tsub" },
      { path: "mod", type: "commit", sha: "tmod" },
    ];
    const { d, calls } = make((c) => {
      if (c.url === `${C}/big?ref=main`) return Response.json(big);
      if (c.url === `${G}/branches/main`) return Response.json({ commit: { commit: { tree: { sha: "troot" } } } });
      if (c.url === `${G}/git/trees/troot`) return Response.json({ sha: "troot", tree: [{ path: "store", type: "tree", sha: "tstore" }, { path: "README", type: "blob", sha: "x", size: 1 }] });
      if (c.url === `${G}/git/trees/tstore`) return Response.json({ sha: "tstore", tree: [{ path: "big", type: "tree", sha: "tbig" }] });
      if (c.url === `${G}/git/trees/tbig`) return Response.json({ sha: "tbig", tree: treeItems });
      return undefined;
    });
    const r = await d.list!("/big");
    expect(r.entries).toHaveLength(1501);
    expect(r.entries[0]).toMatchObject({ name: "sub", path: "/big/sub", isDir: true, etag: "tsub" });
    expect(r.entries.find((e) => e.name === "f1499")).toMatchObject({ path: "/big/f1499", isDir: false, size: 1499, etag: "b1499" });
    expect(r.entries.some((e) => e.name === "mod")).toBe(false);
    expect(calls.every((c) => c.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("少於 1000 筆不呼叫 Trees API；目標樹不存在 → 404", async () => {
    const { d, calls } = make((c) => (c.url === `${C}/small?ref=main` ? Response.json([{ type: "file", name: "a", path: "store/small/a", sha: "s", size: 1 }]) : undefined));
    expect((await d.list!("/small")).entries).toHaveLength(1);
    expect(calls.some((c) => c.url.includes("/git/trees/"))).toBe(false);
    const G = "https://api.github.com/repos/me/files";
    const big = Array.from({ length: 1000 }, (_, i) => ({ type: "file", name: `f${i}`, path: `store/gone/f${i}`, sha: `c${i}`, size: 1 }));
    const m2 = make((c) => {
      if (c.url === `${C}/gone?ref=main`) return Response.json(big);
      if (c.url === `${G}/branches/main`) return Response.json({ commit: { commit: { tree: { sha: "troot" } } } });
      if (c.url === `${G}/git/trees/troot`) return Response.json({ sha: "troot", tree: [] });
      return undefined;
    });
    await expect(m2.d.list!("/gone")).rejects.toThrow(/找不到資料夾/);
  });
});
