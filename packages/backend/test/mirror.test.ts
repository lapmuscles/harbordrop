import { describe, expect, it } from "vitest";
import { mirrorDriver, parseAutoindex, parseRepo, parseSize } from "../src/storage/drivers/mirror";
import { getDriverDef } from "../src/storage/registry";

function mockFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    const h = routes[url];
    return h ? h() : new Response("Not Found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const html = (s: string) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });

const NGINX = `<html><head><title>Index of /pub/</title></head><body><h1>Index of /pub/</h1><hr><pre><a href="../">../</a>
<a href="docs/">docs/</a>                                              14-Nov-2026 01:02                   -
<a href="a%20b.iso">a b.iso</a>                                          13-Nov-2026 09:30          1048576
<a href="%E4%B8%AD%E6%96%87.txt">中文.txt</a>                                  01-Jan-2026 00:00               12
</pre><hr></body></html>`;

const APACHE = `<table><tr><th><a href="?C=N;O=D">Name</a></th><th><a href="?C=M;O=A">Last modified</a></th><th><a href="?C=S;O=A">Size</a></th></tr>
<tr><td valign="top"><img src="/icons/back.gif" alt="[PARENTDIR]"></td><td><a href="/pub/">Parent Directory</a></td><td>&nbsp;</td><td align="right">  - </td></tr>
<tr><td valign="top"><img src="/icons/folder.gif" alt="[DIR]"></td><td><a href="sub/">sub/</a></td><td align="right">2026-11-10 08:15  </td><td align="right">  - </td></tr>
<tr><td valign="top"><img src="/icons/unknown.gif" alt="[   ]"></td><td><a href="x.tar.gz">x.tar.gz</a></td><td align="right">2026-11-11 12:00  </td><td align="right">1.5M</td></tr>
<tr><td><a href="https://other.example.com/evil">外部</a></td></tr>
</table>`;

describe("mirror 驅動：http-index", () => {
  it("已在 registry 登錄且為唯讀", () => {
    expect(getDriverDef("mirror")).toBe(mirrorDriver);
    expect(mirrorDriver.readonly).toBe(true);
    const d = mirrorDriver.create({ type: "http-index", url: "https://m.example.com/pub" }, { platform: "node", fetch: mockFetch({}).fetch });
    const c = d.capabilities;
    expect([c.write, c.delete, c.mkdir, c.rename, c.copy]).toEqual([false, false, false, false, false]);
    expect(c.uploadProtocols).toEqual([]);
    expect(d.put).toBeUndefined();
    expect(d.delete).toBeUndefined();
    expect(d.initUpload).toBeUndefined();
  });

  it("解析 Nginx autoindex：排除 ../、解碼名稱、日期與大小", async () => {
    const { fetch, calls } = mockFetch({ "https://m.example.com/pub/": () => html(NGINX) });
    const d = mirrorDriver.create({ type: "http-index", url: "https://m.example.com/pub" }, { platform: "node", fetch });
    const r = await d.list!("/");
    expect(calls[0].url).toBe("https://m.example.com/pub/");
    expect(r.entries.map((e) => e.name)).toEqual(["docs", "a b.iso", "中文.txt"]);
    expect(r.entries[0]).toMatchObject({ path: "/docs", isDir: true, modifiedAt: Date.UTC(2026, 10, 14, 1, 2) });
    expect(r.entries[1]).toMatchObject({ path: "/a b.iso", isDir: false, size: 1048576 });
    expect(r.entries[2]).toMatchObject({ size: 12, mime: "text/plain" });
  });

  it("解析 Apache autoindex：排除排序連結、上層與外部連結", () => {
    const items = parseAutoindex(APACHE, "https://m.example.com/pub/");
    expect(items).toEqual([
      { name: "sub", isDir: true, size: undefined, modifiedAt: Date.UTC(2026, 10, 10, 8, 15) },
      { name: "x.tar.gz", isDir: false, size: Math.round(1.5 * 1024 * 1024), modifiedAt: Date.UTC(2026, 10, 11, 12, 0) },
    ]);
  });

  it("子目錄網址逐段編碼；stat 由上層列表找出；下載轉址到來源", async () => {
    const { fetch, calls } = mockFetch({
      "https://m.example.com/pub/": () => html(NGINX),
      "https://m.example.com/pub/docs/": () => html(`<pre><a href="../">../</a>\n<a href="r%23.md">r#.md</a> 14-Nov-2026 01:02 3\n</pre>`),
    });
    const d = mirrorDriver.create({ type: "http-index", url: "https://m.example.com/pub/" }, { platform: "node", fetch });
    expect((await d.list!("/docs")).entries).toEqual([expect.objectContaining({ name: "r#.md", path: "/docs/r#.md", size: 3 })]);
    expect(await d.stat("/a b.iso")).toMatchObject({ isDir: false, size: 1048576 });
    expect(await d.stat("/nope")).toBeNull();
    expect(await d.download("/docs/r#.md")).toEqual({ kind: "redirect", url: "https://m.example.com/pub/docs/r%23.md" });
    expect(calls.some((c) => c.url.includes("r%23"))).toBe(false); // 下載不經後端抓取
    await expect(d.list!("/missing")).rejects.toThrow(/找不到/);
  });

  it("testConnection 與錯誤設定", async () => {
    const { fetch } = mockFetch({ "https://m.example.com/pub/": () => html(NGINX) });
    expect(await mirrorDriver.create({ type: "http-index", url: "https://m.example.com/pub" }, { platform: "node", fetch }).testConnection()).toMatchObject({ ok: true });
    expect(await mirrorDriver.create({ type: "http-index", url: "https://m.example.com/x" }, { platform: "node", fetch }).testConnection()).toMatchObject({ ok: false });
    expect(() => mirrorDriver.create({ type: "http-index", url: "ftp://x" }, { platform: "node", fetch })).toThrow(/http/);
    expect(() => mirrorDriver.create({ type: "bogus", url: "https://x" }, { platform: "node", fetch })).toThrow(/不支援/);
    expect(parseSize("-")).toBeUndefined();
    expect(parseSize("2G")).toBe(2 * 1024 ** 3);
  });
});

describe("mirror 驅動：github-releases", () => {
  const API = "https://api.github.com/repos/o/r";
  const rel = {
    tag_name: "v1.0",
    published_at: "2026-11-01T00:00:00Z",
    assets: [
      { name: "app.zip", size: 10, updated_at: "2026-11-01T00:00:00Z", browser_download_url: "https://github.com/o/r/releases/download/v1.0/app.zip" },
      { name: "SHA256SUMS", size: 2, browser_download_url: "https://github.com/o/r/releases/download/v1.0/SHA256SUMS" },
    ],
  };
  const make = (extra: Record<string, () => Response> = {}, token?: string) => {
    const m = mockFetch({
      [`${API}/releases?per_page=100&page=1`]: () =>
        Response.json([rel, { tag_name: "draft", draft: true, assets: [] }], { headers: { link: `<${API}/releases?page=2>; rel="next"` } }),
      [`${API}/releases?per_page=100&page=2`]: () => Response.json([{ tag_name: "v0.9", assets: [] }]),
      [`${API}/releases/tags/v1.0`]: () => Response.json(rel),
      [API]: () => Response.json({ full_name: "o/r" }),
      ...extra,
    });
    return { ...m, d: mirrorDriver.create({ type: "github-releases", url: "https://github.com/o/r.git", token }, { platform: "workers", fetch: m.fetch }) };
  };

  it("parseRepo", () => {
    expect(parseRepo("o/r")).toEqual(["o", "r"]);
    expect(parseRepo("https://github.com/o/r/")).toEqual(["o", "r"]);
    expect(() => parseRepo("nope")).toThrow();
  });

  it("根目錄列出 releases（略過 draft、分頁 cursor）", async () => {
    const { d, calls } = make({}, "ghp_T");
    const p1 = await d.list!("/");
    expect(p1.entries).toEqual([expect.objectContaining({ name: "v1.0", path: "/v1.0", isDir: true, modifiedAt: Date.parse("2026-11-01T00:00:00Z") })]);
    expect(p1.cursor).toBe("2");
    expect(calls[0].headers.authorization).toBe("Bearer ghp_T");
    const p2 = await d.list!("/", { cursor: p1.cursor });
    expect(p2.entries.map((e) => e.name)).toEqual(["v0.9"]);
    expect(p2.cursor).toBeUndefined();
  });

  it("release 資料夾列出 assets；stat；下載轉址到 browser_download_url", async () => {
    const { d } = make();
    expect((await d.list!("/v1.0")).entries.map((e) => [e.name, e.path, e.size])).toEqual([
      ["app.zip", "/v1.0/app.zip", 10],
      ["SHA256SUMS", "/v1.0/SHA256SUMS", 2],
    ]);
    expect(await d.stat("/v1.0")).toMatchObject({ isDir: true });
    expect(await d.stat("/v1.0/app.zip")).toMatchObject({ isDir: false, size: 10, mime: "application/zip" });
    expect(await d.stat("/v1.0/none")).toBeNull();
    expect(await d.stat("/v9")).toBeNull();
    expect(await d.download("/v1.0/app.zip")).toEqual({ kind: "redirect", url: rel.assets[0].browser_download_url });
    await expect(d.list!("/v9")).rejects.toThrow(/找不到/);
    await expect(d.download("/v1.0")).rejects.toThrow(/目錄/);
  });

  it("testConnection 與速率限制", async () => {
    expect(await make().d.testConnection()).toMatchObject({ ok: true });
    const { d } = make({ [`${API}/releases/tags/v1.0`]: () => new Response("", { status: 403 }) });
    await expect(d.stat("/v1.0")).rejects.toThrow(/速率/);
  });
});
