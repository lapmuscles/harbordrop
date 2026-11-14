import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localDriver, LocalDriver, parseRange } from "../src/storage/drivers/local";
import type { StorageDriver } from "../src/storage/types";

let dir: string;
let d: StorageDriver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hd-local-"));
  d = localDriver.create({ root: "files" }, { platform: "node", fetch, dataDir: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stream = (s: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });

describe("本機磁碟驅動", () => {
  it("Workers 平台：create 拒絕並給清楚錯誤；capabilities 全關", async () => {
    expect(localDriver.platforms).toEqual(["node"]);
    expect(() => localDriver.create({ root: "x" }, { platform: "workers", fetch })).toThrow(/僅支援 Node/);
    const w = new LocalDriver({ root: "x" }, { platform: "workers", fetch });
    expect(w.capabilities.write).toBe(false);
    expect(w.capabilities.uploadProtocols).toEqual([]);
    await expect(w.stat("/a")).rejects.toMatchObject({ status: 501, message: expect.stringMatching(/Workers/) });
    expect(await w.testConnection()).toMatchObject({ ok: false });
  });

  it("testConnection 建立根目錄；put / stat / list / 中文檔名", async () => {
    expect(await d.testConnection()).toMatchObject({ ok: true });
    const e = await d.put!("/a/中文.txt", new TextEncoder().encode("hello"), { size: 5 });
    expect(e).toMatchObject({ name: "中文.txt", path: "/a/中文.txt", size: 5, isDir: false, mime: "text/plain" });
    expect(readFileSync(join(dir, "files/a/中文.txt"), "utf8")).toBe("hello");
    await d.put!("/a/s.bin", stream("abc"), { size: 3 });
    await d.mkdir!("/a/sub");
    const l = await d.list!("/a");
    expect(l.entries.map((x) => [x.name, x.isDir])).toEqual([
      ["sub", true],
      ["s.bin", false],
      ["中文.txt", false],
    ]);
    expect(await d.stat("/nope")).toBeNull();
  });

  it("put 大小不符時不留下檔案", async () => {
    await expect(d.put!("/x.bin", new Uint8Array(3), { size: 4 })).rejects.toMatchObject({ status: 400 });
    expect(existsSync(join(dir, "files/x.bin"))).toBe(false);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(dir, "files"))).toEqual([]);
  });

  it("download：完整與 Range（206、416）", async () => {
    await d.put!("/r.txt", new TextEncoder().encode("0123456789"), { size: 10 });
    const full = await d.download("/r.txt", { filename: "下載.txt" });
    if (full.kind !== "response") throw new Error("應為 response");
    expect(full.response.status).toBe(200);
    expect(await full.response.text()).toBe("0123456789");
    expect(full.response.headers.get("content-disposition")).toContain("attachment");

    const part = await d.download("/r.txt", { request: new Request("http://h", { headers: { range: "bytes=2-4" } }), inline: true });
    if (part.kind !== "response") throw new Error();
    expect(part.response.status).toBe(206);
    expect(part.response.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await part.response.text()).toBe("234");

    const bad = await d.download("/r.txt", { request: new Request("http://h", { headers: { range: "bytes=50-" } }) });
    if (bad.kind !== "response") throw new Error();
    expect(bad.response.status).toBe(416);
    await expect(d.download("/none")).rejects.toMatchObject({ status: 404 });
  });

  it("parseRange 邊界", () => {
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=0-100", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=a-b", 10)).toBe("invalid");
    expect(parseRange(null, 10)).toBeNull();
  });

  it("rename / copy / delete", async () => {
    await d.put!("/d/f.txt", new TextEncoder().encode("x"), { size: 1 });
    await d.copy!("/d", "/e");
    await d.rename!("/d/f.txt", "/g/h.txt");
    expect(await d.stat("/e/f.txt")).toMatchObject({ size: 1 });
    expect(await d.stat("/g/h.txt")).toMatchObject({ size: 1 });
    expect(await d.stat("/d/f.txt")).toBeNull();
    await expect(d.rename!("/e", "/e/sub")).rejects.toMatchObject({ status: 400 });
    await d.delete!(["/e", "/g/h.txt", "/missing"]);
    expect(await d.stat("/e")).toBeNull();
    await expect(d.delete!(["/"])).rejects.toMatchObject({ status: 400 });
  });

  it("防路徑穿越：.. 與指向根目錄外的符號連結", async () => {
    await d.testConnection();
    await expect(d.stat("/../secret")).rejects.toMatchObject({ code: "path_traversal" });
    await expect(d.put!("/a/../../x", new Uint8Array(1), { size: 1 })).rejects.toMatchObject({ code: "path_traversal" });
    writeFileSync(join(dir, "secret.txt"), "top secret");
    mkdirSync(join(dir, "outside"));
    symlinkSync(join(dir, "outside"), join(dir, "files", "link"));
    symlinkSync(join(dir, "secret.txt"), join(dir, "files", "s.txt"));
    await expect(d.download("/s.txt")).rejects.toMatchObject({ code: "path_traversal" });
    await expect(d.put!("/link/new.txt", new Uint8Array(1), { size: 1 })).rejects.toMatchObject({ code: "path_traversal" });
    expect(existsSync(join(dir, "outside", "new.txt"))).toBe(false);
  });
});
