import type { UploadInitResponse } from "../api-types";
import type { HdClient } from "./api";
import { retryingFetch, type UploadHooks, type UploadStats } from "./common";

/**
 * Google Drive resumable upload（protocol = "gdrive-resumable"）：
 * - 後端建立 session（帶瀏覽器 Origin），只給瀏覽器 session URI（uploadUrl）
 * - 分片依序 PUT，大小為 256 KiB 的倍數（最後一片除外），Content-Range: bytes a-b/total
 * - 伺服器回 308 + Range: bytes=0-N 表示已收到 0..N，下一片從 N+1 開始（可能少於送出的量）
 * - 續傳：PUT 空 body 且 Content-Range: bytes * /total 查詢進度（308 或已完成的 200/201）
 * - 完成回 200/201 與檔案 JSON；回傳 { id } 作為完成 body
 */

const UNIT = 256 * 1024;

/** 解析 308 的 Range 標頭（bytes=0-12345）→ 下一個位移 */
export function gdriveNextOffset(range: string | null): number {
  if (!range) return 0;
  const m = /bytes=(\d+)-(\d+)/.exec(range);
  return m ? Number(m[2]) + 1 : 0;
}

export async function uploadGDriveResumable(
  api: HdClient,
  session: UploadInitResponse,
  file: Blob,
  hooks: UploadHooks = {},
): Promise<{ stats: UploadStats; id: string | null }> {
  const stats: UploadStats = { protocol: "gdrive-resumable", attempts: [], skipped: 0, startedAt: Date.now() };
  const client = session.client as { uploadUrl: string; chunkSize?: number };
  const uploadUrl = client.uploadUrl;
  if (!uploadUrl) throw new Error("缺少 Google Drive 上傳網址");
  const total = file.size;
  const chunkSize = Math.max(UNIT, Math.floor((client.chunkSize || 8 * 1024 * 1024) / UNIT) * UNIT);
  const report = (loaded: number) => hooks.onProgress?.({ phase: "uploading", fraction: total ? loaded / total : 1, loaded, total });

  let doneId: string | null = null;
  const finish = async (r: Response) => {
    const j: any = await r.json().catch(() => ({}));
    doneId = typeof j.id === "string" ? j.id : null;
  };

  /** 查詢已收到的位移；已完成時回傳 total */
  const status = async (): Promise<number> => {
    const r = await retryingFetch(api.fetch, uploadUrl, { method: "PUT", headers: { "content-range": `bytes */${total}` } }, { kind: "control", id: "status", index: 0 }, hooks, stats);
    if (r.status === 308) return gdriveNextOffset(r.headers.get("range"));
    if (r.status === 200 || r.status === 201) {
      await finish(r);
      return total;
    }
    if (r.status === 404 || r.status === 410) throw new Error("Google Drive 上傳工作階段已失效或過期，請重新上傳");
    throw new Error(`查詢上傳狀態失敗：HTTP ${r.status}`);
  };

  let offset = await status();
  if (offset > 0) stats.skipped = Math.ceil(offset / chunkSize);
  report(offset);

  let resyncs = 0;
  while (doneId === null && offset < total) {
    hooks.signal?.throwIfAborted();
    const end = Math.min(total, offset + chunkSize);
    const index = Math.floor(offset / chunkSize) + 1;
    const buf = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    let r: Response;
    try {
      r = await retryingFetch(
        api.fetch,
        uploadUrl,
        { method: "PUT", headers: { "content-range": `bytes ${offset}-${end - 1}/${total}` }, body: buf },
        { kind: "part", id: String(index), index },
        hooks,
        stats,
      );
    } catch (e) {
      if (hooks.signal?.aborted || resyncs >= 5) throw e;
      resyncs++;
      offset = await status();
      report(offset);
      continue;
    }
    if (r.status === 308) {
      const next = gdriveNextOffset(r.headers.get("range"));
      if (next <= offset && ++resyncs > 5) throw new Error("Google Drive 分片持續未被接受");
      offset = next;
      await hooks.resume?.add(`${session.sessionId}:${index}`);
      report(offset);
      continue;
    }
    if (r.status === 200 || r.status === 201) {
      await finish(r);
      offset = total;
      await hooks.resume?.add(`${session.sessionId}:${index}`);
      break;
    }
    if (r.status === 404 || r.status === 410) throw new Error("Google Drive 上傳工作階段已失效或過期，請重新上傳");
    throw new Error(`Google Drive 分片上傳失敗：HTTP ${r.status}`);
  }

  // 0 位元組檔案：status() 查詢即會完成；若仍未拿到結果（例如全部位元組已送達但最後回應遺失）再查一次
  if (doneId === null) await status();
  report(total);
  stats.finishedAt = Date.now();
  return { stats, id: doneId };
}
