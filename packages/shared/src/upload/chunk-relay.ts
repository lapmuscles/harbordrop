import type { UploadInitResponse } from "../api-types";
import type { HdClient } from "./api";
import { retryingFetch, type UploadHooks, type UploadStats } from "./common";

/**
 * chunk-relay：不支援瀏覽器直傳的渠道（Telegram、Discord）。
 * - 片大小由後端驅動決定（session.client.chunkSize），每片 POST /api/uploads/:id/chunk?index=N
 * - 每片獨立指數退避重試（retryingFetch）；失敗只重傳該片
 * - 續傳：開始前 GET /api/uploads/:id/chunk 取得後端已收到的分片，只補傳缺少的
 */
export async function uploadChunkRelay(api: HdClient, session: UploadInitResponse, file: Blob, hooks: UploadHooks = {}): Promise<{ stats: UploadStats; chunkCount: number }> {
  const stats: UploadStats = { protocol: "chunk-relay", attempts: [], skipped: 0, startedAt: Date.now() };
  const c = session.client as { chunkSize: number; chunkCount?: number; concurrency?: number };
  const chunkSize = Number(c.chunkSize || session.partSize);
  if (!chunkSize) throw new Error("後端未提供分片大小");
  const chunkCount = Math.max(1, Math.ceil(file.size / chunkSize));
  const sizeOf = (i: number) => Math.min(chunkSize, file.size - i * chunkSize);
  const base = `${api.baseUrl}/api/uploads/${session.sessionId}/chunk`;

  // 續傳：後端已收到的分片（大小相符才算數）
  const done = new Set<number>();
  try {
    const r = await api.fetch(base, { method: "GET", credentials: "include", headers: api.headers(api.sessionHeaders(session)) });
    if (r.ok) {
      const j = (await r.json()) as { chunks: { index: number; size: number }[] };
      for (const ch of j.chunks ?? []) if (ch.index < chunkCount && ch.size === sizeOf(ch.index)) done.add(ch.index);
    }
  } catch {}
  stats.skipped = done.size;

  let loaded = [...done].reduce((s, i) => s + sizeOf(i), 0);
  const report = () => hooks.onProgress?.({ phase: "uploading", fraction: file.size ? loaded / file.size : 1, loaded, total: file.size });
  report();

  const todo = Array.from({ length: chunkCount }, (_, i) => i).filter((i) => !done.has(i));
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      hooks.signal?.throwIfAborted();
      const i = todo[next++];
      const buf = new Uint8Array(await file.slice(i * chunkSize, i * chunkSize + sizeOf(i)).arrayBuffer());
      const r = await retryingFetch(
        api.fetch,
        `${base}?index=${i}`,
        { method: "POST", credentials: "include", headers: api.headers(api.sessionHeaders(session, { "Content-Type": "application/octet-stream" })), body: buf },
        { kind: "part", id: String(i), index: i },
        hooks,
        stats,
      );
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        let msg = `HTTP ${r.status}`;
        try {
          msg = JSON.parse(text)?.error?.message ?? msg;
        } catch {}
        throw new Error(`第 ${i} 片上傳失敗：${msg}`);
      }
      await r.body?.cancel().catch(() => {});
      await hooks.resume?.add(`${session.sessionId}:${i}`);
      loaded += buf.byteLength;
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(c.concurrency || 2, todo.length || 1)) }, worker));
  stats.finishedAt = Date.now();
  return { stats, chunkCount };
}
