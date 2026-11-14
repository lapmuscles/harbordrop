import type { ShareOptionsInput, UploadCompleteResponse, UploadInitResponse } from "../api-types";
import type { HdClient } from "./api";
import type { UploadHooks, UploadStats } from "./common";
import { uploadXet } from "./xet";
import { uploadS3Multipart } from "./s3";
import { uploadChunkRelay } from "./chunk-relay";
import { uploadGraphSession } from "./graph";
import { uploadGDriveResumable } from "./gdrive";

export * from "./api";
export * from "./common";
export * from "./retry";
export { uploadXet } from "./xet";
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
  /** 回呼：工作階段建立後（可存起來供續傳） */
  onSession?(s: UploadInitResponse): void;
}

/** 完整流程：建立工作階段 → 依協定直傳 → 完成並建立分享 */
export async function uploadFile(api: HdClient, file: Blob, opts: UploadFileOptions): Promise<UploadCompleteResponse & { stats: UploadStats; session: UploadInitResponse }> {
  const session = await api.initUpload({ storageId: opts.storageId, filename: opts.filename, size: file.size, mime: opts.mime, share: opts.share });
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
