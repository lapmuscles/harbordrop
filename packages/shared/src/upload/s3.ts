import type { UploadInitResponse } from "../api-types";
import type { HdClient } from "./api";
import { retryingFetch, type UploadHooks, type UploadStats } from "./common";

/**
 * S3 multipart 直傳：後端預簽章各分片 URL，瀏覽器直接 PUT 分片到 S3。
 * - 分片大小由後端決定（預設 16MB），同時上傳數預設 4
 * - 每個分片獨立指數退避重試；簽章過期（403）會重新簽章
 * - 續傳：開始前向後端查詢 S3 已收到的分片（list-parts），只補傳缺少的
 */
export async function uploadS3Multipart(api: HdClient, session: UploadInitResponse, file: Blob, hooks: UploadHooks = {}): Promise<{ stats: UploadStats; parts: { partNumber: number; etag: string }[] }> {
  const stats: UploadStats = { protocol: "s3-multipart", attempts: [], skipped: 0, startedAt: Date.now() };
  const { partSize, partCount, concurrency } = session.client as { partSize: number; partCount: number; concurrency: number };
  const etags = new Map<number, string>();

  // 續傳：S3 端已有的分片
  const existing = await api.action<{ parts: { partNumber: number; etag: string; size: number }[] }>(session, "list-parts").catch(() => ({ parts: [] }));
  for (const p of existing.parts) {
    const expected = Math.min(partSize, file.size - (p.partNumber - 1) * partSize);
    if (p.size === expected) {
      etags.set(p.partNumber, p.etag);
      stats.skipped++;
    }
  }

  let loaded = [...etags.keys()].reduce((s, n) => s + Math.min(partSize, file.size - (n - 1) * partSize), 0);
  const report = () => hooks.onProgress?.({ phase: "uploading", fraction: file.size ? loaded / file.size : 1, loaded, total: file.size });
  report();

  const todo = Array.from({ length: partCount }, (_, i) => i + 1).filter((n) => !etags.has(n));
  const urls = new Map<number, string>();
  const sign = async (nums: number[]) => {
    const r = await api.action<{ urls: Record<string, string> }>(session, "sign-parts", { partNumbers: nums });
    for (const [k, v] of Object.entries(r.urls)) urls.set(Number(k), v);
  };

  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const n = todo[next++];
      if (!urls.has(n)) await sign(todo.slice(next - 1, next + 19).filter((x) => !urls.has(x)));
      const body = file.slice((n - 1) * partSize, Math.min(file.size, n * partSize));
      // Node 的 fetch 不接受部分 Blob 實作差異，統一轉成 ArrayBuffer 以便重試時重複使用
      const buf = new Uint8Array(await body.arrayBuffer());
      let r: Response;
      for (let resign = 0; ; resign++) {
        r = await retryingFetch(api.fetch, urls.get(n)!, { method: "PUT", body: buf }, { kind: "part", id: String(n), index: n }, hooks, stats);
        if (r.status === 403 && resign < 2) {
          await sign([n]);
          continue;
        }
        break;
      }
      if (!r.ok) throw new Error(`分片 ${n} 上傳失敗：HTTP ${r.status}`);
      const etag = r.headers.get("etag");
      if (!etag) throw new Error("S3 未回傳 ETag（請在 bucket CORS 設定 ExposeHeaders: ETag）");
      etags.set(n, etag);
      await hooks.resume?.add(`${session.sessionId}:${n}`);
      loaded += buf.byteLength;
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency || 4, todo.length || 1)) }, worker));
  stats.finishedAt = Date.now();
  return { stats, parts: [...etags.entries()].sort((a, b) => a[0] - b[0]).map(([partNumber, etag]) => ({ partNumber, etag })) };
}
