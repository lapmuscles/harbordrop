import type { ShareOptionsInput, UploadCompleteResponse, UploadInitResponse } from "../api-types";
import type { HdClient } from "./api";
import type { UploadHooks, UploadStats } from "./common";
import { folderBasename, newFolderGroupId, type FolderItem } from "./folder";
import { uploadXet } from "./xet";
import { uploadS3Multipart } from "./s3";
import { uploadChunkRelay } from "./chunk-relay";
import { uploadGraphSession } from "./graph";
import { uploadGDriveResumable } from "./gdrive";

export * from "./api";
export * from "./common";
export * from "./retry";
export * from "./folder";
export { uploadXet, uploadXetBatch, type XetBatchEntry } from "./xet";
export { uploadS3Multipart } from "./s3";
export { uploadChunkRelay } from "./chunk-relay";
export { uploadGraphSession, graphNextOffset } from "./graph";
export { uploadGDriveResumable, gdriveNextOffset } from "./gdrive";

/**
 * 協定實作表。新增渠道的瀏覽器直傳協定：實作 (api, session, file, hooks) => 完成 body，加到這裡。
 */
export type ProtocolHandler = (api: HdClient, session: UploadInitResponse, file: Blob, hooks: UploadHooks) => Promise<{ stats: UploadStats; completeBody: unknown }>;

export const PROTOCOLS: Record<string, ProtocolHandler> = {
  xet: async (api, s, file, hooks) => ({ stats: await uploadXet(api, s, file, hooks, String(s.client.resumeScope ?? "xet")), completeBody: {} }),
  "s3-multipart": async (api, s, file, hooks) => {
    const { stats, parts } = await uploadS3Multipart(api, s, file, hooks);
    return { stats, completeBody: { parts } };
  },
  "chunk-relay": async (api, s, file, hooks) => {
    const { stats, chunkCount } = await uploadChunkRelay(api, s, file, hooks);
    return { stats, completeBody: { chunkCount } };
  },
  // feat/ms-google
  "graph-upload-session": async (api, s, file, hooks) => {
    const { stats, item } = await uploadGraphSession(api, s, file, hooks);
    return { stats, completeBody: { item: item ? { id: item.id, size: item.size } : null } };
  },
  "gdrive-resumable": async (api, s, file, hooks) => {
    const { stats, id } = await uploadGDriveResumable(api, s, file, hooks);
    return { stats, completeBody: { id } };
  },
};

export interface UploadFileOptions extends UploadHooks {
  storageId: number;
  filename: string;
  mime?: string;
  share?: ShareOptionsInput;
  /** 文件夾內的相對路徑（例如 photos/sub/a.jpg）；後端只取目錄部分併入儲存路徑 */
  relativePath?: string;
  /** 同一批上傳共用的隨機段，取代路徑範本的 {rand} */
  groupId?: string;
  /** 回呼：工作階段建立後（可存起來供續傳） */
  onSession?(s: UploadInitResponse): void;
}

/** 完整流程：建立工作階段 → 依協定直傳 → 完成並建立分享 */
export async function uploadFile(api: HdClient, file: Blob, opts: UploadFileOptions): Promise<UploadCompleteResponse & { stats: UploadStats; session: UploadInitResponse }> {
  const session = await api.initUpload({ storageId: opts.storageId, filename: opts.filename, size: file.size, mime: opts.mime, share: opts.share, relativePath: opts.relativePath, groupId: opts.groupId });
  opts.onSession?.(session);
  const handler = PROTOCOLS[session.protocol];
  if (!handler) throw new Error(`瀏覽器不支援上傳協定：${session.protocol}`);
  try {
    const { stats, completeBody } = await handler(api, session, file, opts);
    opts.onProgress?.({ phase: "committing", fraction: 1, total: file.size });
    const done = await api.complete(session, completeBody);
    opts.onProgress?.({ phase: "done", fraction: 1, total: file.size });
    return { ...done, stats, session };
  } catch (e) {
    if (opts.signal?.aborted) await api.abort(session).catch(() => {});
    throw e;
  }
}

export interface FolderUploadResult {
  /** 已完成的檔案（每檔各自的分享） */
  done: { item: FolderItem; res: UploadCompleteResponse & { stats: UploadStats; session: UploadInitResponse } }[];
  /** 失敗的檔案（其餘檔案不受影響，繼續上傳） */
  failed: { item: FolderItem; error: Error }[];
  /** 是否因取消而中途停止（未上傳的檔案既不在 done 也不在 failed） */
  aborted: boolean;
}

export interface UploadFolderOptions extends UploadHooks {
  storageId: number;
  share?: ShareOptionsInput;
  /** 同一批上傳共用的隨機段；未填則自動產生 */
  groupId?: string;
  onFileStart?(item: FolderItem, index: number): void;
  onFileDone?(item: FolderItem, index: number, res: UploadCompleteResponse & { stats: UploadStats; session: UploadInitResponse }): void;
  onFileError?(item: FolderItem, index: number, error: Error): void;
  /** 整體進度：已完成位元組／總位元組（目前檔案的進度即時反映） */
  onOverallProgress?(info: { loaded: number; total: number; done: number; count: number }): void;
  onSession?(s: UploadInitResponse, item: FolderItem, index: number): void;
}

/**
 * 逐檔循序上傳整個文件夾：每檔各自建立工作階段與分享（沿用既有分享機制），
 * 相對路徑保留在儲存路徑裡，同批檔案共用一個 groupId 落在同一目錄。
 * 單檔失敗不中斷其餘檔案；自訂連結 slug 不適用於多檔，一律忽略（每檔隨機連結）。
 */
export async function uploadFolder(api: HdClient, items: FolderItem[], opts: UploadFolderOptions): Promise<FolderUploadResult> {
  const total = items.reduce((s, it) => s + it.file.size, 0);
  const groupId = opts.groupId ?? newFolderGroupId();
  const share = opts.share ? { ...opts.share, slug: undefined } : undefined;
  const result: FolderUploadResult = { done: [], failed: [], aborted: false };
  let loadedBase = 0; // 已完成檔案的位元組
  for (let i = 0; i < items.length; i++) {
    if (opts.signal?.aborted) {
      result.aborted = true;
      break;
    }
    const item = items[i];
    opts.onFileStart?.(item, i);
    try {
      const res = await uploadFile(api, item.file, {
        ...opts,
        storageId: opts.storageId,
        filename: folderBasename(item.relativePath),
        mime: (item.file as File).type || undefined,
        share,
        relativePath: item.relativePath,
        groupId,
        onProgress: (p) => {
          opts.onProgress?.(p);
          opts.onOverallProgress?.({ loaded: loadedBase + (p.loaded ?? Math.round(p.fraction * item.file.size)), total, done: result.done.length, count: items.length });
        },
        onSession: (s) => opts.onSession?.(s, item, i),
      });
      result.done.push({ item, res });
      loadedBase += item.file.size;
      opts.onFileDone?.(item, i, res);
      opts.onOverallProgress?.({ loaded: loadedBase, total, done: result.done.length, count: items.length });
    } catch (e: any) {
      if (opts.signal?.aborted) {
        result.aborted = true;
        break;
      }
      const err = e instanceof Error ? e : new Error(String(e));
      result.failed.push({ item, error: err });
      loadedBase += item.file.size;
      opts.onFileError?.(item, i, err);
      opts.onOverallProgress?.({ loaded: loadedBase, total, done: result.done.length, count: items.length });
    }
  }
  return result;
}
