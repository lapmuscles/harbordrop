import { describe, expect, it } from "vitest";
import { parseMultiStatus, webdavDriver } from "../src/storage/drivers/webdav";

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };

const MS = (items: { href: string; dir?: boolean; len?: number; ct?: string }[]) =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">` +
  items
    .map(
      (i) =>
        `<d:response><d:href>${i.href}</d:href><d:propstat><d:prop>` +
        `<d:resourcetype>${i.dir ? "<d:collection/>" : ""}</d:resourcetype>` +
        (i.len !== undefined ? `<d:getcontentlength>${i.len}</d:getcontentlength>` : "") +
        (i.ct ? `<d:getcontenttype>${i.ct}</d:getcontenttype>` : "") +
        `<d:getlastmodified>Sat, 14 Nov 2026 01:00:00 GMT</d:getlastmodified><d:getetag>"abc"</d:getetag>` +
        `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
    )
    .join("") +
  `</d:multistatus>`;

function make(handler: (c: Call) => Response | undefined, cfg: Record<string, any> = {}) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body };
    calls.push(c);
    return handler(c) ?? new Response("nf", { status: 404 });
  }) as typeof globalThis.fetch;
  const d = webdavDriver.create({ url: "https://dav.test/remote/files/", username: "使用者", password: "p@ss", root: "/data", ...cfg }, { platform: "workers", fetch });
  return { d, calls };
}

describe("WebDAV 驅動", () => {
  it("解析 multistatus（不同命名空間前綴、中文 href）", () => {
    const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a/%E4%B8%AD%E6%96%87.txt</D:href><D:propstat><D:prop><lp1:getcontentlength xmlns:lp1="DAV:">5</lp1:getcontentlength><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;
    const r = parseMultiStatus(xml);
    expect(r).toEqual([expect.objectContaining({ href: "/a/中文.txt", isDir: false, size: 5 })]);
  });

  it("list：PROPFIND Depth 1，略過自身並帶 Basic Auth", async () => {
    const { d, calls } = make((c) =>
      c.method === "PROPFIND"
        ? new Response(
            MS([
              { href: "/remote/files/data/dir/", dir: true },
              { href: "/remote/files/data/dir/sub/", dir: true },
              { href: "https://dav.test/remote/files/data/dir/%E6%AA%94%20a.txt", len: 12, ct: "text/plain" },
            ]),
            { status: 207 },
          )
        : undefined,
    );
    const r = await d.list!("/dir");
    expect(calls[0].url).toBe("https://dav.test/remote/files/data/dir/");
    expect(calls[0].headers.depth).toBe("1");
    expect(calls[0].headers.authorization).toMatch(/^Basic /);
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(calls[0].headers.authorization.slice(6)), (ch) => ch.charCodeAt(0)));
    expect(decoded).toBe("使用者:p@ss");
    expect(r.entries).toEqual([
      expect.objectContaining({ name: "sub", path: "/dir/sub", isDir: true }),
      expect.objectContaining({ name: "檔 a.txt", path: "/dir/檔 a.txt", isDir: false, size: 12, mime: "text/plain", etag: "abc" }),
    ]);
  });

  it("stat：404 回傳 null；檔案回傳資訊", async () => {
    const { d } = make((c) => (c.url.endsWith("/x.bin") ? new Response(MS([{ href: "/remote/files/data/x.bin", len: 3 }]), { status: 207 }) : undefined));
    expect(await d.stat("/nope")).toBeNull();
    expect(await d.stat("/x.bin")).toEqual(expect.objectContaining({ name: "x.bin", size: 3, isDir: false }));
  });

  it("download：轉送 Range 並回傳 206 與 Content-Disposition", async () => {
    const { d, calls } = make((c) =>
      c.method === "GET" ? new Response("bc", { status: 206, headers: { "content-range": "bytes 1-2/5", "content-length": "2", "content-type": "text/plain" } }) : undefined,
    );
    const t = await d.download("/a.txt", { request: new Request("http://h", { headers: { range: "bytes=1-2" } }), filename: "中.txt" });
    expect(calls[0].headers.range).toBe("bytes=1-2");
    expect(t.kind).toBe("response");
    if (t.kind !== "response") return;
    expect(t.response.status).toBe(206);
    expect(t.response.headers.get("content-range")).toBe("bytes 1-2/5");
    expect(t.response.headers.get("content-disposition")).toContain("filename*=UTF-8''%E4%B8%AD.txt");
    expect(await t.response.text()).toBe("bc");
  });

  it("put：先 MKCOL 父資料夾（405 視為已存在）再 PUT", async () => {
    const { d, calls } = make((c) => {
      if (c.method === "MKCOL") return new Response(null, { status: c.url.endsWith("/a/") ? 405 : 201 });
      if (c.method === "PUT") return new Response(null, { status: 201 });
      if (c.method === "PROPFIND") return new Response(MS([{ href: "/remote/files/data/a/b/f.bin", len: 3 }]), { status: 207 });
    });
    const e = await d.put!("/a/b/f.bin", new Uint8Array([1, 2, 3]), { size: 3, mime: "application/x-test" });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "MKCOL https://dav.test/remote/files/data/a/",
      "MKCOL https://dav.test/remote/files/data/a/b/",
      "PUT https://dav.test/remote/files/data/a/b/f.bin",
      "PROPFIND https://dav.test/remote/files/data/a/b/f.bin",
    ]);
    expect(calls[2].headers["content-type"]).toBe("application/x-test");
    expect(e.size).toBe(3);
  });

  it("put：超過上限回 413；401 給清楚錯誤", async () => {
    const { d } = make((c) => (c.method === "PUT" ? new Response("no", { status: 401 }) : undefined));
    await expect(d.put!("/f", new Uint8Array(1), { size: 200 * 1024 * 1024 })).rejects.toMatchObject({ status: 413 });
    await expect(d.put!("/f", new Uint8Array(1), { size: 1 })).rejects.toThrow(/帳號或密碼錯誤/);
  });

  it("delete：404 忽略；mkdir 用 MKCOL", async () => {
    const { d, calls } = make((c) => (c.method === "DELETE" && c.url.endsWith("/a") ? new Response(null, { status: 204 }) : c.method === "MKCOL" ? new Response(null, { status: 201 }) : undefined));
    await d.delete!(["/a", "/missing"]);
    await d.mkdir!("/新資料夾");
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "DELETE", "MKCOL"]);
    expect(calls[2].url).toBe("https://dav.test/remote/files/data/%E6%96%B0%E8%B3%87%E6%96%99%E5%A4%BE/");
    await expect(d.delete!(["/"])).rejects.toMatchObject({ status: 400 });
  });

  it("rename / copy：MOVE、COPY 帶 Destination 與 Overwrite", async () => {
    const { d, calls } = make((c) => {
      if (c.method === "PROPFIND") return new Response(MS([{ href: "/remote/files/data/a.txt", len: 1 }]), { status: 207 });
      if (c.method === "MOVE" || c.method === "COPY") return new Response(null, { status: 201 });
    });
    await d.rename!("/a.txt", "/b.txt");
    await d.copy!("/a.txt", "/c.txt");
    const mv = calls.find((c) => c.method === "MOVE")!;
    const cp = calls.find((c) => c.method === "COPY")!;
    expect(mv.url).toBe("https://dav.test/remote/files/data/a.txt");
    expect(mv.headers.destination).toBe("https://dav.test/remote/files/data/b.txt");
    expect(mv.headers.overwrite).toBe("T");
    expect(cp.headers.destination).toBe("https://dav.test/remote/files/data/c.txt");
    await expect(d.rename!("/a", "/a/b")).rejects.toMatchObject({ status: 400 });
  });

  it("路徑穿越被拒、testConnection 回報結果", async () => {
    const { d } = make((c) => (c.method === "PROPFIND" ? new Response(MS([{ href: "/remote/files/data/", dir: true }]), { status: 207 }) : undefined));
    await expect(d.stat("/../etc")).rejects.toThrow();
    expect(await d.testConnection()).toMatchObject({ ok: true });
    const bad = make(() => new Response("x", { status: 401 }));
    expect(await bad.d.testConnection()).toMatchObject({ ok: false, message: expect.stringMatching(/帳號或密碼/) });
  });
});
