import { describe, expect, it } from "vitest";
import { HdClient, uploadChunkRelay, MemoryResumeStore } from "../src/upload";
import type { UploadInitResponse } from "../src/api-types";

/** 模擬後端 chunk 端點：記錄每片 POST 次數；第 2 片第一次回 503 */
function fakeBackend(already: number[] = []) {
  const posts = new Map<number, number>();
  const got = new Map<number, number>(already.map((i) => [i, 4]));
  const f = (async (url: string, init: RequestInit = {}) => {
    expect(new Headers(init.headers).get("x-upload-token")).toBe("tok");
    if (url.endsWith("/chunk") && (init.method ?? "GET") === "GET") return Response.json({ chunks: [...got].map(([index, size]) => ({ index, size })) });
    const m = /\/chunk\?index=(\d+)$/.exec(url);
    if (m) {
      const i = Number(m[1]);
      posts.set(i, (posts.get(i) ?? 0) + 1);
      if (i === 2 && posts.get(i) === 1) return new Response("busy", { status: 503 });
      got.set(i, (init.body as Uint8Array).byteLength);
      return Response.json({ index: i, size: (init.body as Uint8Array).byteLength });
    }
    return new Response("?", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, posts, got };
}

const session = (size: number): UploadInitResponse => ({ sessionId: "s1", uploadToken: "tok", protocol: "chunk-relay", client: { chunkSize: 4, chunkCount: Math.ceil(size / 4), concurrency: 2 }, partSize: 4 }) as UploadInitResponse;

describe("chunk-relay 瀏覽器端", () => {
  it("依後端片大小切片；失敗只重傳該片；回報進度", async () => {
    const be = fakeBackend();
    const api = new HdClient({ baseUrl: "http://h", fetch: be.f });
    const fr: number[] = [];
    const resume = new MemoryResumeStore();
    const r = await uploadChunkRelay(api, session(14), new Blob([new Uint8Array(14)]), { retry: { baseDelayMs: 1 }, onProgress: (p) => fr.push(p.fraction), resume });
    expect(r.chunkCount).toBe(4);
    expect([...be.posts.entries()].sort()).toEqual([[0, 1], [1, 1], [2, 2], [3, 1]]);
    expect([...be.got.entries()].sort()).toEqual([[0, 4], [1, 4], [2, 4], [3, 2]]);
    expect(fr.at(-1)).toBe(1);
    expect(resume.keys.has("s1:3")).toBe(true);
    expect(r.stats.attempts.filter((a) => !a.ok)).toHaveLength(1);
  });
  it("續傳：只補傳後端沒有的分片", async () => {
    const be = fakeBackend([0, 1]);
    const api = new HdClient({ baseUrl: "http://h", fetch: be.f });
    const r = await uploadChunkRelay(api, session(12), new Blob([new Uint8Array(12)]), { retry: { baseDelayMs: 1 } });
    expect(r.stats.skipped).toBe(2);
    expect([...be.posts.keys()]).toEqual([2]);
  });
  it("不可重試的錯誤直接失敗並帶後端訊息", async () => {
    const f = (async (url: string) =>
      url.endsWith("/chunk") ? Response.json({ chunks: [] }) : Response.json({ error: { message: "分片大小錯誤" } }, { status: 400 })) as unknown as typeof fetch;
    await expect(uploadChunkRelay(new HdClient({ baseUrl: "http://h", fetch: f }), session(4), new Blob([new Uint8Array(4)]))).rejects.toThrow("分片大小錯誤");
  });
});
