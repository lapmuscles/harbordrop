import { commitIter } from "@huggingface/hub";
import type { UploadInitResponse } from "../api-types";
import type { HdClient } from "./api";
import { retryingFetch, urlOf, type UploadHooks, type UploadStats } from "./common";

/**
 * HuggingFace Xet 直傳（瀏覽器與 Node 共用）。
 *
 * 使用 @huggingface/hub 的 commitIter（內含 wasm 版 xet 切塊／xorb／shard 產生器），
 * 但 hubUrl 指向後端的工作階段代理，因此：
 *  - HF token 永不進入瀏覽器；xet 寫入權杖由後端 xet-token 端點換發（短效）
 *  - xorb／shard 直接 POST 到 cas-server（不經後端）
 *  - 每個 xorb 請求各自指數退避重試；成功的 xorb 記入 ResumeStore，續傳時直接略過
 *  - commit 由後端代為提交（瀏覽器送出的 commit 內容只用來驗證 sha256／大小）
 */
export async function uploadXet(
  api: HdClient,
  session: UploadInitResponse,
  file: Blob,
  hooks: UploadHooks = {},
  resumeNamespace = "xet",
): Promise<UploadStats> {
  const stats: UploadStats = { protocol: "xet", attempts: [], skipped: 0, startedAt: Date.now() };
  const hubUrl = `${api.baseUrl}/api/uploads/${session.sessionId}/action/hub`;
  const sessionPrefix = `${api.baseUrl}/api/uploads/${session.sessionId}/`;
  let xorbIndex = 0;
  let ctrlIndex = 0;
  const base = api.fetch;

  const xetFetch: typeof fetch = async (input, init = {}) => {
    const url = urlOf(input);
    const method = (init.method ?? "GET").toUpperCase();
    // 1) 送往後端代理（preupload / LFS batch / xet-token / commit）：附上上傳權杖
    if (url.startsWith(sessionPrefix)) {
      const headers = new Headers(init.headers);
      headers.set("X-Upload-Token", session.uploadToken);
      const req = { ...init, headers, credentials: "include" as RequestCredentials };
      if (/\/commit\/[^/]+$/.test(url)) return base(url, req); // commit 不自動重試，避免重複提交
      return retryingFetch(base, url, req, { kind: "control", id: url.slice(sessionPrefix.length), index: ctrlIndex++ }, hooks, stats);
    }
    // 2) xorb 上傳：逐一重試＋續傳略過
    const xorb = /\/v1\/xorbs\/[^/]+\/([0-9a-f]{64})$/.exec(url);
    if (xorb && method === "POST") {
      const key = `${resumeNamespace}:${xorb[1]}`;
      if (await hooks.resume?.has(key)) {
        stats.skipped++;
        return new Response(JSON.stringify({ was_inserted: false }), { status: 200 });
      }
      const r = await retryingFetch(base, url, init, { kind: "xorb", id: xorb[1], index: xorbIndex++ }, hooks, stats);
      if (r.ok) await hooks.resume?.add(key);
      return r;
    }
    if (/\/v1\/shards$/.test(url)) return retryingFetch(base, url, init, { kind: "shard", id: "shard", index: 0 }, hooks, stats);
    if (/\/v1\/chunks\//.test(url)) return retryingFetch(base, url, init, { kind: "dedup", id: url.split("/").pop()!, index: 0 }, hooks, stats);
    // 3) 其他（例如 HF 回退為 LFS 時的 S3 分片 URL）
    return retryingFetch(base, url, init, { kind: "other", id: url.split("?")[0].slice(-40), index: 0 }, hooks, stats);
  };

  const c = session.client as { repo: string; path: string; revision: string };
  const iter = commitIter({
    repo: { type: "dataset", name: c.repo },
    operations: [{ operation: "addOrUpdate", path: c.path, content: file }],
    title: "HarborDrop upload",
    hubUrl,
    branch: c.revision,
    fetch: xetFetch,
    useXet: true,
    abortSignal: hooks.signal,
  });
  let phase: "hashing" | "uploading" | "committing" = "hashing";
  let lastEmit = 0;
  for await (const ev of iter) {
    if (ev.event === "phase") {
      if (ev.phase === "committing") phase = "committing";
      hooks.onProgress?.({ phase, fraction: phase === "committing" ? 1 : 0, total: file.size });
    } else if (ev.event === "fileProgress") {
      const next = ev.state === "hashing" ? "hashing" : "uploading";
      // 雜湊階段事件極多（每個讀取區塊一次），節流到每 100ms 一次
      if (next === phase && ev.progress < 1 && Date.now() - lastEmit < 100) continue;
      lastEmit = Date.now();
      phase = next;
      hooks.onProgress?.({ phase, fraction: ev.progress, loaded: Math.round(ev.progress * file.size), total: file.size });
    }
  }
  stats.finishedAt = Date.now();
  return stats;
}
