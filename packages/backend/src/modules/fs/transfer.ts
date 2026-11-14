import type { AppContext } from "../../core/context";
import type { StorageDriver } from "../../storage/types";
import { joinPath } from "../../storage/util";
import { registerTaskHandler, updateProgress, type TaskView } from "../tasks/service";

/**
 * 跨儲存（或驅動不支援原生 copy/rename 時）的複製／搬移背景工作。
 * payload 即續跑狀態：每處理一項就寫回，cron 下次從佇列繼續。
 */
export const TRANSFER_KIND = "fs.transfer";

export interface Loc {
  storageId: number;
  path: string;
}
export interface TransferItem {
  src: Loc;
  dst: Loc;
  isDir?: boolean;
}
export interface TransferPayload {
  move: boolean;
  queue: TransferItem[];
  /** 搬移時，全部成功後要從來源刪除的頂層項目 */
  roots: Loc[];
  copied: number;
  failed: { path: string; error: string }[];
  /** 顯示用 */
  label?: string;
}

export function newTransferPayload(items: TransferItem[], move: boolean, label?: string): TransferPayload {
  return { move, queue: items, roots: move ? items.map((i) => i.src) : [], copied: 0, failed: [], label };
}

async function copyFile(ctx: AppContext, src: StorageDriver, dst: StorageDriver, from: string, to: string, size?: number, mime?: string) {
  if (!dst.put) throw new Error("目標儲存不支援經後端寫入");
  const t = await src.download(from);
  const res = t.kind === "redirect" ? await ctx.driverCtx.fetch(t.url) : t.response;
  if (!res.ok || !res.body) throw new Error(`讀取來源失敗（HTTP ${res.status}）`);
  const len = size ?? (Number(res.headers.get("content-length")) || 0);
  if (dst.capabilities.maxProxyUploadBytes !== undefined && len > dst.capabilities.maxProxyUploadBytes) {
    await res.body.cancel().catch(() => {});
    throw new Error("檔案超過目標儲存的經後端寫入上限");
  }
  await dst.put(to, res.body, { size: len, mime: mime ?? res.headers.get("content-type") ?? undefined });
}

export async function runTransferStep(ctx: AppContext, task: TaskView, step: { deadline: number; isCancelled(): Promise<boolean> }) {
  const p = task.payload as TransferPayload;
  let total = task.total;
  let progress = task.progress;
  const drivers = new Map<number, StorageDriver>();
  const drv = async (id: number) => {
    let d = drivers.get(id);
    if (!d) drivers.set(id, (d = await ctx.storage.driver(id)));
    return d;
  };
  while (p.queue.length && Date.now() < step.deadline) {
    if (await step.isCancelled()) return { done: false };
    const it = p.queue[0]; // 處理完才移出佇列，中斷時可重做
    try {
      const src = await drv(it.src.storageId);
      const dst = await drv(it.dst.storageId);
      const st = await src.stat(it.src.path);
      if (!st) throw new Error("來源不存在");
      if (st.isDir) {
        if (!src.list) throw new Error("來源儲存不支援列目錄");
        await dst.mkdir?.(it.dst.path);
        let cursor: string | undefined;
        do {
          const r = await src.list(it.src.path, { cursor });
          for (const e of r.entries) {
            p.queue.push({ src: { storageId: it.src.storageId, path: joinPath(it.src.path, e.name) }, dst: { storageId: it.dst.storageId, path: joinPath(it.dst.path, e.name) }, isDir: e.isDir });
            total++;
          }
          cursor = r.cursor;
        } while (cursor);
      } else {
        await copyFile(ctx, src, dst, it.src.path, it.dst.path, st.size, st.mime);
        p.copied++;
      }
    } catch (e: any) {
      p.failed.push({ path: it.src.path, error: String(e?.message ?? e).slice(0, 300) });
    }
    p.queue.shift();
    progress++;
    await updateProgress(ctx, task.id, { progress, total, payload: p });
  }
  if (p.queue.length) return { done: false };
  if (p.failed.length) {
    throw new Error(`${p.failed.length} 個項目失敗${p.move ? "，來源未刪除" : ""}：${p.failed.slice(0, 3).map((f) => `${f.path}（${f.error}）`).join("、")}`);
  }
  if (p.move) {
    const byStorage = new Map<number, string[]>();
    for (const r of p.roots) byStorage.set(r.storageId, [...(byStorage.get(r.storageId) ?? []), r.path]);
    for (const [sid, paths] of byStorage) {
      const d = await drv(sid);
      if (!d.delete) throw new Error("已複製完成，但來源儲存不支援刪除，未能完成搬移");
      await d.delete(paths);
    }
  }
  return { done: true, result: { copied: p.copied, moved: p.move } };
}

registerTaskHandler(TRANSFER_KIND, runTransferStep);
