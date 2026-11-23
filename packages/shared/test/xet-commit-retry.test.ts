import { describe, expect, it, vi } from "vitest";

// 攔截 @huggingface/hub 的 commitIter：只取它拿到的 fetch，不跑 wasm 切塊流程。
let capturedFetch: typeof fetch | undefined;
vi.mock("@huggingface/hub", () => ({
  commitIter: (opts: any) => {
    capturedFetch = opts.fetch;
    return (async function* () {})();
  },
}));

import { HdClient } from "../src/upload/api";
import { uploadXet } from "../src/upload/xet";

const session = {
  sessionId: "sess1",
  uploadToken: "tok1",
  protocol: "xet",
  client: { repo: "harbordrop/upload", path: "a.jpg", revision: "main" },
};
const commitUrl =
  "https://x.test/api/uploads/sess1/action/hub/api/datasets/harbordrop/upload/commit/main";

async function setup(responses: number[]) {
  capturedFetch = undefined;
  const calls: string[] = [];
  const queue = [...responses];
  const mockFetch = (async (url: any) => {
    calls.push(String(url));
    const status = queue.shift() ?? 200;
    return new Response(JSON.stringify({ ok: status === 200 }), { status });
  }) as typeof fetch;
  const api = new HdClient({ baseUrl: "https://x.test", fetch: mockFetch });
  await uploadXet(api, session as any, new Blob(["x"]), { retry: { baseDelayMs: 1, maxDelayMs: 5 } });
  expect(capturedFetch).toBeDefined();
  return { calls, fetch: capturedFetch! };
}

describe("commit 重試", () => {
  it("429 連續兩次後成功：共送 3 次", async () => {
    const { calls, fetch } = await setup([429, 429, 200]);
    const r = await fetch(commitUrl, { method: "POST", body: "{}\n" });
    expect(r.status).toBe(200);
    expect(calls.filter((u) => u.includes("/commit/")).length).toBe(3);
  });

  it("502 重試後成功", async () => {
    const { calls, fetch } = await setup([502, 200]);
    const r = await fetch(commitUrl, { method: "POST", body: "{}\n" });
    expect(r.status).toBe(200);
    expect(calls.filter((u) => u.includes("/commit/")).length).toBe(2);
  });

  it("400 不重試：只送 1 次", async () => {
    const { calls, fetch } = await setup([400]);
    const r = await fetch(commitUrl, { method: "POST", body: "{}\n" });
    expect(r.status).toBe(400);
    expect(calls.filter((u) => u.includes("/commit/")).length).toBe(1);
  });
});
