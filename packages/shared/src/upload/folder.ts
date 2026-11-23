/**
 * 文件夾上傳的純函式（瀏覽器與 Node 測試共用，不依賴 DOM）。
 *
 * 相對路徑慣例：以 `/` 分隔，第一段為最上層文件夾名，例如 `photos/sub/a.jpg`。
 * webkitdirectory 選出的 File 自帶 webkitRelativePath；拖放則由前端
 * `filesFromDataTransfer()` 遍歷 FileSystemEntry 產生（見 frontend/src/folder.ts）。
 */

export interface FolderItem {
  file: Blob;
  /** 文件夾內的相對路徑（含最上層文件夾名） */
  relativePath: string;
}

export const folderBasename = (p: string): string => p.split("/").pop() || p;

export const folderDirname = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

/** 由 webkitdirectory 的 FileList 收集：用 webkitRelativePath，缺失時退回檔名 */
export function collectFolderFiles(files: ArrayLike<File>): FolderItem[] {
  const items: FolderItem[] = [];
  for (const f of Array.from(files)) {
    const rel = ((f as File).webkitRelativePath || f.name).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!rel) continue;
    items.push({ file: f, relativePath: rel });
  }
  return items;
}

/** 同一批文件夾上傳共用的 groupId（16 字元英數字，取代路徑範本的 {rand}） */
export function newFolderGroupId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
