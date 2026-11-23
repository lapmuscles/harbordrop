import { collectFolderFiles, type FolderItem } from "@harbordrop/shared/upload";

export type { FolderItem };
export { collectFolderFiles };

/**
 * 拖放：遍歷 DataTransferItem，支援拖入資料夾（webkitGetAsEntry）。
 * 瀏覽器不支援 entry 時退回 dataTransfer.files（僅檔案，相對路徑即檔名）。
 * 空資料夾沒有檔案，不會出現在結果裡（瀏覽器 API 的限制）。
 */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<FolderItem[]> {
  const items = [...(dt.items ?? [])];
  const hasEntry = items.some((it) => typeof it.webkitGetAsEntry === "function");
  if (!hasEntry) return collectFolderFiles(dt.files);
  const out: FolderItem[] = [];
  for (const it of items) {
    const entry = it.webkitGetAsEntry?.();
    if (entry) await walkEntry(entry, "", out);
  }
  return out;
}

async function walkEntry(entry: FileSystemEntry, base: string, out: FolderItem[]): Promise<void> {
  const path = base ? `${base}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const f = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file: f, relativePath: path });
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries 可能分批回傳，讀到空為止
    for (;;) {
      const batch: FileSystemEntry[] = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, path, out);
    }
  }
}
