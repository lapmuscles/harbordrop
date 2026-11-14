import { describe, expect, it } from "vitest";
import { HdClient, uploadGraphSession, uploadGDriveResumable, graphNextOffset, gdriveNextOffset } from "../src/upload";
import type { UploadInitResponse } from "../src/api-types";

const KiB = 1024;
const sess = (protocol: string, client: Record<string, unknown>): UploadInitResponse => ({ sessionId: "s", uploadToken: "t", protocol, client });
const file = (n: number) => new Blob([new Uint8Array(n).map((_, i) => i % 251)]);
const fast = { retry: { retries: 3, baseDelayMs: 1, maxDelayMs: 2 } };

/** 模擬 OneDrive uploadUrl：記錄收到的位元組，可設定預先已收到的量與一次 503 */
function fakeGraph(total: number, opts: { pre?: number; fail503At?: number } = {}) {
  let received = opts.pre ?? 0;
  const ranges: string[] = [];
  let failed = false;
  const f = (async (url: string, init: RequestInit = {}) => {
    expect(url).toBe("https://up.onedrive/sess");
    const h = new Headers(init.headers);
    expect(h.get("authorization")).toBeNull();
    if ((init.method ?? "GET") === "GET") return Response.json({ nextExpectedRanges: received < total ? [`${received}-`] : [] });
    const cr = h.get("content-range")!;
    ranges.push(cr);
    const [, a, b] = /bytes (\d+)-(\d+)\/\d+/.exec(cr)!.map(Number);
    if (opts.fail503At === a && !failed) {
      failed = true;
      return new Response("busy", { status: 503 });
    }
    if (a !== received) return new Response("bad range", { status: 416 });
    expect((init.body as Uint8Array).byteLength).toBe(b - a + 1);
    received = b + 1;
    if (received === total) return Response.json({ id: "ITEM", size: total }, { status: 201 });
    return Response.json({ nextExpectedRanges: [`${received}-`] }, { status: 202 });
  }) as typeof fetch;
  return { f, ranges, get received() { return received; } };
}

describe("graph-upload-session（瀏覽器）", () => {
  it("分片大小為 320 KiB 倍數、依序上傳、503 重試、最後回 item", async () => {
    const total = 700 * KiB;
    const srv = fakeGraph(total, { fail503At: 320 * KiB });
    const api = new HdClient({ baseUrl: "http://h", fetch: srv.f });
    const r = await uploadGraphSession(api, sess("graph-upload-session", { uploadUrl: "https://up.onedrive/sess", chunkSize: 500 * KiB }), file(total), fast);
    expect(r.item).toEqual({ id: "ITEM", size: total });
    expect(srv.ranges).toEqual([`bytes 0-327679/${total}`, `bytes 327680-655359/${total}`, `bytes 327680-655359/${total}`, `bytes 655360-716799/${total}`]);
    expect(r.stats.attempts.some((a) => a.status === 503)).toBe(true);
  });

  it("續傳：從 nextExpectedRanges 的位移繼續", async () => {
    const total = 1000 * KiB;
    const srv = fakeGraph(total, { pre: 640 * KiB });
    const api = new HdClient({ baseUrl: "http://h", fetch: srv.f });
    const r = await uploadGraphSession(api, sess("graph-upload-session", { uploadUrl: "https://up.onedrive/sess", chunkSize: 320 * KiB }), file(total), fast);
    expect(srv.ranges[0]).toBe(`bytes ${640 * KiB}-${960 * KiB - 1}/${total}`);
    expect(r.stats.skipped).toBe(2);
    expect(r.item.id).toBe("ITEM");
  });

  it("後端已處理 0 位元組（done）時不發任何請求", async () => {
    const api = new HdClient({ baseUrl: "http://h", fetch: (async () => { throw new Error("不應呼叫"); }) as any });
    const r = await uploadGraphSession(api, sess("graph-upload-session", { done: true }), file(0));
    expect(r.item).toBeNull();
  });

  it("graphNextOffset", () => {
    expect(graphNextOffset(["26-"], 100)).toBe(26);
    expect(graphNextOffset(["40-50", "10-20"], 100)).toBe(10);
    expect(graphNextOffset([], 100)).toBe(100);
  });
});

/** 模擬 Google resumable session URI；可設定每片只接受部分位元組 */
function fakeGDrive(total: number, opts: { pre?: number; acceptMax?: number; dropFirst?: boolean } = {}) {
  let received = opts.pre ?? 0;
  const puts: string[] = [];
  let dropped = false;
  const f = (async (url: string, init: RequestInit = {}) => {
    expect(url).toBe("https://www.googleapis.com/upload/drive/v3/files?upload_id=X");
    const cr = new Headers(init.headers).get("content-range")!;
    puts.push(cr);
    const done = () => Response.json({ id: "FILEID", name: "a.bin", size: String(total) }, { status: 200 });
    const partial = () => new Response(null, { status: 308, headers: received ? { range: `bytes=0-${received - 1}` } : {} });
    if (cr.startsWith("bytes */")) return received === total ? done() : partial();
    const [, a, b] = /bytes (\d+)-(\d+)\/\d+/.exec(cr)!.map(Number);
    if (opts.dropFirst && !dropped) {
      dropped = true;
      throw new TypeError("network down");
    }
    if (a !== received) return partial();
    const accepted = Math.min(b - a + 1, opts.acceptMax ?? Infinity);
    received = a + accepted;
    return received === total ? done() : partial();
  }) as typeof fetch;
  return { f, puts };
}

describe("gdrive-resumable（瀏覽器）", () => {
  it("256 KiB 倍數分片、308 Range 推進、完成回 id", async () => {
    const total = 600 * KiB;
    const srv = fakeGDrive(total);
    const api = new HdClient({ baseUrl: "http://h", fetch: srv.f });
    const r = await uploadGDriveResumable(api, sess("gdrive-resumable", { uploadUrl: "https://www.googleapis.com/upload/drive/v3/files?upload_id=X", chunkSize: 300 * KiB }), file(total), fast);
    expect(r.id).toBe("FILEID");
    expect(srv.puts).toEqual([`bytes */${total}`, `bytes 0-262143/${total}`, `bytes 262144-524287/${total}`, `bytes 524288-614399/${total}`]);
  });

  it("伺服器只收部分位元組時依 Range 重送剩餘；網路中斷後查詢進度續傳", async () => {
    const total = 512 * KiB + 10;
    const srv = fakeGDrive(total, { acceptMax: 200 * KiB, dropFirst: true });
    const api = new HdClient({ baseUrl: "http://h", fetch: srv.f });
    const r = await uploadGDriveResumable(api, sess("gdrive-resumable", { uploadUrl: "https://www.googleapis.com/upload/drive/v3/files?upload_id=X", chunkSize: 256 * KiB }), file(total), fast);
    expect(r.id).toBe("FILEID");
    expect(srv.puts).toContain(`bytes ${200 * KiB}-${200 * KiB + 256 * KiB - 1}/${total}`);
  });

  it("續傳：已收到的部分不重送", async () => {
    const total = 512 * KiB;
    const srv = fakeGDrive(total, { pre: 256 * KiB });
    const api = new HdClient({ baseUrl: "http://h", fetch: srv.f });
    const r = await uploadGDriveResumable(api, sess("gdrive-resumable", { uploadUrl: "https://www.googleapis.com/upload/drive/v3/files?upload_id=X", chunkSize: 256 * KiB }), file(total), fast);
    expect(srv.puts.slice(1)).toEqual([`bytes 262144-524287/${total}`]);
    expect(r.stats.skipped).toBe(1);
  });

  it("0 位元組：以 bytes */0 完成", async () => {
    const srv = fakeGDrive(0);
    const api = new HdClient({ baseUrl: "http://h", fetch: srv.f });
    const r = await uploadGDriveResumable(api, sess("gdrive-resumable", { uploadUrl: "https://www.googleapis.com/upload/drive/v3/files?upload_id=X" }), file(0), fast);
    expect(r.id).toBe("FILEID");
    expect(srv.puts).toEqual(["bytes */0"]);
  });

  it("gdriveNextOffset", () => {
    expect(gdriveNextOffset("bytes=0-99")).toBe(100);
    expect(gdriveNextOffset(null)).toBe(0);
  });
});
