import { describe, expect, it, vi } from "vitest";

// 攔截 @huggingface/hub 的 commitIter：取它拿到的 fetch 與 operations，
// 並模擬每檔的 fileProgress 事件，不跑 wasm 切塊流程。
let captured: { fetch?: typeof fetch; operations?: any[]; title?: string } = {};
vi.mock("@huggingface/hub", () => ({
  commitIter: (opts: any) => {
    captured = { fetch: opts.fetch, operations: opts.operations, title: opts.title };
    return (async function* () {
      yield { event: "fileProgress", path: "a.txt", progress: 0.5, state: "uploading" };
      yield { event: "fileProgress", path: "sub/b.txt", progress: 0.5, state: "uploading" };
      yield { event: "fileProgress", path: "a.txt", progress: 1, state: "uploading" };
      yield { event: "fileProgress", path: "sub/b.txt", progress: 1, state: "uploading" };
      yield { event: "phase", phase: "committing" };
    })();
  },
}));

import { HdClient } from "../src/upload/api";
import { uploadXetBatch } from "../src/upload/xet";

const session = {
  sessionId: "sess1",
  uploadToken: "tok1",
  protocol: "xet",
  client: { repo: "harbordrop/upload", revision: "main", resumeScope: "xet:abc" },
};
const commitUrl =
  "https://x.test/api/uploads/sess1/action/hub/api/datasets/harbordrop/upload/commit/main";

function entries() {
  return [
    { path: "a.txt", file: new Blob(["0123456789"]) },
    { path: "sub/b.txt", file: new Blob(["01234567890123456789"]) },
  ];
}

describe("批次上傳 uploadXetBatch", () => {
  it("一次 commitIter、兩個操作、進度為整批彙總", async () => {
    captured = {};
    const api = new HdClient({ baseUrl: "https://x.test", fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch });
    const seen: { fraction: number; loaded?: number; total: number; phase: string }[] = [];
    const stats = await uploadXetBatch(api, session as any, entries(), {
      onProgress: (p) => seen.push({ fraction: p.fraction, loaded: p.loaded, total: p.total, phase: p.phase }),
    });
    expect(captured.operations).toHaveLength(2);
    expect(captured.operations!.map((o: any) => o.path)).toEqual(["a.txt", "sub/b.txt"]);
    expect(captured.title).toContain("2");
    expect(stats.protocol).toBe("xet");
    const last = seen[seen.length - 1];
    expect(last.total).toBe(30);
    expect(last.loaded).toBe(30);
    expect(last.fraction).toBe(1);
    expect(last.phase).toBe("committing");
  });

  it("沒有檔案就拒絕", async () => {
    const api = new HdClient({ baseUrl: "https://x.test", fetch: (async () => new Response("{}", { status: 200 })) as typeof fetch });
    await expect(uploadXetBatch(api, session as any, [])).rejects.toThrow("缺少檔案");
  });

  it("批次 commit 遇 429 會重試", async () => {
    captured = {};
    const calls: string[] = [];
    const queue = [429, 429, 200];
    const mockFetch = (async (url: any) => {
      calls.push(String(url));
      return new Response("{}", { status: queue.shift() ?? 200 });
    }) as typeof fetch;
    const api = new HdClient({ baseUrl: "https://x.test", fetch: mockFetch });
    await uploadXetBatch(api, session as any, entries(), { retry: { baseDelayMs: 1, maxDelayMs: 5 } });
    const r = await captured.fetch!(commitUrl, { method: "POST", body: "{}\n" });
    expect(r.status).toBe(200);
    expect(calls.filter((u) => u.includes("/commit/"))).toHaveLength(3);
  });
});
