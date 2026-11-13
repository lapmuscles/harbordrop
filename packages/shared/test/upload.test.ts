import { describe, expect, it } from "vitest";
import { backoffDelay, withRetry, NonRetryableError } from "../src/upload/retry";
import { HdClient, uploadS3Multipart, MemoryResumeStore } from "../src/upload";
import type { UploadInitResponse } from "../src/api-types";

describe("指數退避", () => {
  it("延遲隨次數增加且有上限", () => {
    for (let i = 0; i < 20; i++) {
      expect(backoffDelay(1, 100, 1000)).toBeGreaterThanOrEqual(50);
      expect(backoffDelay(1, 100, 1000)).toBeLessThanOrEqual(100);
      expect(backoffDelay(10, 100, 1000)).toBeLessThanOrEqual(1000);
    }
  });
  it("withRetry 重試後成功；NonRetryableError 立即失敗", async () => {
    let n = 0;
    expect(await withRetry(async () => (++n < 3 ? Promise.reject(new Error("x")) : "ok"), { baseDelayMs: 1 })).toBe("ok");
    expect(n).toBe(3);
    let m = 0;
    await expect(withRetry(async () => (m++, Promise.reject(new NonRetryableError("no"))), { baseDelayMs: 1 })).rejects.toThrow("no");
    expect(m).toBe(1);
  });
});

/** 模擬後端＋S3：記錄每個分片的 PUT 次數；分片 2 第一次回 503 */
function fakeServer() {
  const puts = new Map<number, number>();
  const stored = new Map<number, number>();
  let signCalls = 0;
  const f = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/action/list-parts")) return Response.json({ parts: [...stored].map(([partNumber, size]) => ({ partNumber, etag: `"e${partNumber}"`, size })) });
    if (url.endsWith("/action/sign-parts")) {
      signCalls++;
      const { partNumbers } = JSON.parse(String(init.body));
      return Response.json({ urls: Object.fromEntries(partNumbers.map((n: number) => [n, `https://s3/part/${n}`])) });
    }
    const m = /part\/(\d+)$/.exec(url);
    if (m) {
      const n = Number(m[1]);
      puts.set(n, (puts.get(n) ?? 0) + 1);
      if (n === 2 && puts.get(n) === 1) return new Response("busy", { status: 503 });
      stored.set(n, (init.body as Uint8Array).byteLength);
      return new Response(null, { status: 200, headers: { etag: `"e${n}"` } });
    }
    return new Response("?", { status: 404 });
  }) as typeof fetch;
  return { f, puts, stored, signCalls: () => signCalls };
}

const session = (partCount: number): UploadInitResponse => ({ sessionId: "s", uploadToken: "t", protocol: "s3-multipart", client: { partSize: 10, partCount, concurrency: 4 }, partSize: 10 });

describe("S3 multipart 客戶端", () => {
  it("分片並行上傳，失敗分片單獨重試", async () => {
    const srv = fakeServer();
    const api = new HdClient({ baseUrl: "http://h", fetch: srv.f });
    const file = new Blob([new Uint8Array(45)]);
    const retries: string[] = [];
    const { parts, stats } = await uploadS3Multipart(api, session(5), file, { retry: { baseDelayMs: 1 }, onRetry: (r) => retries.push(r.id), resume: new MemoryResumeStore() });
    expect(parts.map((p) => p.partNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(retries).toEqual(["2"]);
    expect([...srv.puts.values()]).toEqual(expect.arrayContaining([1, 1, 1, 1, 2]));
    expect(srv.puts.get(2)).toBe(2);
    expect(srv.stored.get(5)).toBe(5);
    expect(stats.attempts.filter((a) => !a.ok)).toHaveLength(1);
  });
  it("續傳：S3 已有的分片不再上傳", async () => {
    const srv = fakeServer();
    srv.stored.set(1, 10).set(3, 10);
    srv.puts.set(2, 1); // 讓分片 2 不再故障
    const api = new HdClient({ baseUrl: "http://h", fetch: srv.f });
    const { parts, stats } = await uploadS3Multipart(api, session(4), new Blob([new Uint8Array(40)]));
    expect(stats.skipped).toBe(2);
    expect(parts).toHaveLength(4);
    expect(srv.puts.get(1)).toBeUndefined();
    expect(srv.puts.get(3)).toBeUndefined();
  });
});
