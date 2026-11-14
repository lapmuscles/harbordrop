import type { UploadInitResponse } from "../api-types";
import type { HdClient } from "./api";
import { retryingFetch, type UploadHooks, type UploadStats } from "./common";

/**
 * Microsoft Graph 上傳工作階段（protocol = "graph-upload-session"）：
 * - 後端 createUploadSession 後只給瀏覽器 uploadUrl（本身即授權，不可帶 Authorization）
 * - 分片依序 PUT，大小為 320 KiB 的倍數（最後一片除外），Content-Range: bytes a-b/total
 * - 續傳：開始前與失敗後以 GET uploadUrl 讀 nextExpectedRanges，從伺服器預期的位移繼續
 * - 最後一片回 200/201 與 driveItem；回傳 { item } 作為完成 body
 */

const UNIT = 320 * 1024;

/** 解析 nextExpectedRanges（例如 ["26-", "40-100"]）→ 第一個缺少的位移 */
export function graphNextOffset(ranges: unknown, total: number): number {
  if (!Array.isArray(ranges) || ranges.length === 0) return total;
  const starts = ranges.map((r) => Number(String(r).split("-")[0])).filter((n) => Number.isFinite(n));
  return starts.length ? Math.min(...starts) : 0;
}

export async function uploadGraphSession(
  api: HdClient,
  session: UploadInitResponse,
  file: Blob,
  hooks: UploadHooks = {},
): Promise<{ stats: UploadStats; item: any }> {
  const stats: UploadStats = { protocol: "graph-upload-session", attempts: [], skipped: 0, startedAt: Date.now() };
  const client = session.client as { uploadUrl?: string; chunkSize?: number; done?: boolean };
  const total = file.size;
  if (client.done || !client.uploadUrl) {
    stats.finishedAt = Date.now();
    return { stats, item: null };
  }
  const uploadUrl = client.uploadUrl;
  const chunkSize = Math.max(UNIT, Math.floor((client.chunkSize || 10 * 1024 * 1024) / UNIT) * UNIT);
  const report = (loaded: number) => hooks.onProgress?.({ phase: "uploading", fraction: total ? loaded / total : 1, loaded, total });

  /** 向 OneDrive 查詢下一個預期位移（全部收到 = total） */
  const status = async (): Promise<number> => {
    const r = await retryingFetch(api.fetch, uploadUrl, { method: "GET" }, { kind: "control", id: "status", index: 0 }, hooks, stats);
    if (r.status === 404) throw new Error("OneDrive 上傳工作階段已失效或過期，請重新上傳");
    if (!r.ok) throw new Error(`查詢上傳狀態失敗：HTTP ${r.status}`);
    const j: any = await r.json().catch(() => ({}));
    return graphNextOffset(j.nextExpectedRanges, total);
  };

  let offset = await status();
  if (offset > 0) stats.skipped = Math.ceil(offset / chunkSize);
  report(offset);

  let item: any = null;
  let index = Math.floor(offset / chunkSize);
  let resyncs = 0;
  while (offset < total) {
    hooks.signal?.throwIfAborted();
    const end = Math.min(total, offset + chunkSize);
    const buf = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    let r: Response;
    try {
      r = await retryingFetch(
        api.fetch,
        uploadUrl,
        { method: "PUT", headers: { "content-range": `bytes ${offset}-${end - 1}/${total}` }, body: buf },
        { kind: "part", id: String(index + 1), index: index + 1 },
        hooks,
        stats,
      );
    } catch (e) {
      if (hooks.signal?.aborted || resyncs >= 5) throw e;
      resyncs++;
      offset = await status();
      index = Math.floor(offset / chunkSize);
      report(offset);
      continue;
    }
    if (r.status === 200 || r.status === 201) {
      item = await r.json().catch(() => null);
      offset = total;
      await hooks.resume?.add(`${session.sessionId}:${index + 1}`);
      report(total);
      break;
    }
    if (r.status === 202) {
      const j: any = await r.json().catch(() => ({}));
      await hooks.resume?.add(`${session.sessionId}:${index + 1}`);
      offset = j.nextExpectedRanges ? graphNextOffset(j.nextExpectedRanges, total) : end;
      index = Math.floor(offset / chunkSize);
      report(offset);
      continue;
    }
    // 416（範圍不符）、409 等：與伺服器重新同步位移後再試
    if ((r.status === 416 || r.status === 409) && resyncs < 5) {
      resyncs++;
      offset = await status();
      index = Math.floor(offset / chunkSize);
      report(offset);
      continue;
    }
    throw new Error(`OneDrive 分片上傳失敗：HTTP ${r.status}`);
  }
  stats.finishedAt = Date.now();
  return { stats, item };
}
