import { describe, expect, it } from "vitest";
import { filesFromDataTransfer } from "../src/folder";

const fileEntry = (name: string, content = "x") =>
  ({
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (f: File) => void) => ok(new File([content], name)),
  }) as unknown as FileSystemFileEntry;

/** createReader 分批回傳：第一批 children，之後空陣列 */
const dirEntry = (name: string, children: FileSystemEntry[], batches = 1) =>
  ({
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let n = 0;
      return {
        readEntries: (ok: (e: FileSystemEntry[]) => void) => {
          if (n >= batches) return ok([]);
          const per = Math.ceil(children.length / batches);
          ok(children.slice(n * per, (n + 1) * per));
          n++;
        },
      };
    },
  }) as unknown as FileSystemDirectoryEntry;

const dtWith = (entries: (FileSystemEntry | null)[]) =>
  ({
    items: entries.map((e) => ({ webkitGetAsEntry: () => e })),
    files: [],
  }) as unknown as DataTransfer;

describe("filesFromDataTransfer", () => {
  it("拖入資料夾：遍歷子目錄，保留相對路徑", async () => {
    const photos = dirEntry("photos", [fileEntry("a.jpg"), dirEntry("sub", [fileEntry("b.txt")])]);
    const items = await filesFromDataTransfer(dtWith([photos]));
    expect(items.map((i) => i.relativePath).sort()).toEqual(["photos/a.jpg", "photos/sub/b.txt"]);
    expect(await (items[0].file as File).text()).toBe("x");
  });

  it("readEntries 分批回傳時全部讀完", async () => {
    const d = dirEntry("d", [fileEntry("1.txt"), fileEntry("2.txt"), fileEntry("3.txt"), fileEntry("4.txt")], 2);
    const items = await filesFromDataTransfer(dtWith([d]));
    expect(items.map((i) => i.relativePath).sort()).toEqual(["d/1.txt", "d/2.txt", "d/3.txt", "d/4.txt"]);
  });

  it("拖入單一檔案：相對路徑即檔名", async () => {
    const items = await filesFromDataTransfer(dtWith([fileEntry("solo.txt")]));
    expect(items).toHaveLength(1);
    expect(items[0].relativePath).toBe("solo.txt");
  });

  it("不支援 webkitGetAsEntry 時退回 dataTransfer.files", async () => {
    const f = new File(["y"], "plain.txt");
    const dt = { items: [{ kind: "file" }], files: [f] } as unknown as DataTransfer;
    const items = await filesFromDataTransfer(dt);
    expect(items.map((i) => i.relativePath)).toEqual(["plain.txt"]);
  });

  it("空資料夾沒有檔案，回傳空清單", async () => {
    const items = await filesFromDataTransfer(dtWith([dirEntry("empty", [])]));
    expect(items).toEqual([]);
  });
});
