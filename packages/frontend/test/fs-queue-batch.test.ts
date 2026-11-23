import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// fs/client 經 ../api 在模組載入時讀 location.origin；Node 測試環境先補上
vi.stubGlobal("location", { origin: "http://test.invalid" });
// 上傳請求一律離線失敗，避免測試打真網路
vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));

// 批次上傳走 fsUploadBatch（mock），逐檔走 fsUpload（預設不應被呼叫）
vi.mock("../src/fs/upload", () => ({
  fsUpload: vi.fn().mockResolvedValue({ protocol: "proxy" }),
  fsUploadBatch: vi.fn().mockResolvedValue({ protocol: "xet", entries: [] }),
  fetchProxyPut: vi.fn(),
}));

type Client = typeof import("../src/fs/client");
let c: Client;
let up: typeof import("../src/fs/upload");

const folderItems = () => [
  { file: new File(["a"], "a.txt"), relativePath: "a.txt" },
  { file: new File(["bb"], "b.txt"), relativePath: "sub/b.txt" },
  { file: new File(["ccc"], "c.txt"), relativePath: "sub/deep/c.txt" },
];

describe("文件夾上傳：一次 commit 的批次項目", () => {
  beforeAll(async () => {
    c = await import("../src/fs/client");
    up = await import("../src/fs/upload");
  });
  beforeEach(() => {
    c.queue.items = [];
    c.queue.concurrency = 0;
    vi.clearAllMocks();
  });

  it("enqueueFolder 只建立一個佇列項目，含整批檔案與標籤", () => {
    c.enqueueFolder("/up", folderItems() as any);
    expect(c.queue.items).toHaveLength(1);
    const it = c.queue.items[0];
    expect(it.batch?.entries).toHaveLength(3);
    expect(it.batch?.entries.map((e) => e.relativePath)).toEqual(["a.txt", "sub/b.txt", "sub/deep/c.txt"]);
    expect(it.label).toContain("3");
    expect(it.dir).toBe("/up");
    expect(it.notifyDir).toBe("/up");
    expect(it.status).toBe("waiting");
  });

  it("拖放零散檔案走逐檔上傳（一檔一次 commit），拖放資料夾走一次 commit 的批次", () => {
    c.enqueueDropped("/up", [
      { file: new File(["a"], "a.txt"), relativePath: "a.txt" },
      { file: new File(["b"], "b.txt"), relativePath: "b.txt" },
    ] as any);
    expect(c.queue.items).toHaveLength(2);
    expect(c.queue.items.every((i) => i.batch === undefined)).toBe(true);

    c.queue.items = [];
    c.enqueueDropped("/up", folderItems() as any);
    expect(c.queue.items).toHaveLength(1);
    expect(c.queue.items[0].batch?.entries).toHaveLength(3);
  });

  it("空資料夾不建立項目", () => {
    c.enqueueFolder("/up", []);
    expect(c.queue.items).toHaveLength(0);
  });

  it("單檔上傳仍逐檔建立項目、沒有 batch", () => {
    c.enqueue("/", [new File(["x"], "a.txt"), new File(["y"], "b.txt")]);
    expect(c.queue.items).toHaveLength(2);
    expect(c.queue.items[0].batch).toBeUndefined();
    expect(c.queue.items[0].label).toBeUndefined();
  });

  it("執行批次項目時只呼叫一次 fsUploadBatch、完成後狀態為 done", async () => {
    c.queue.concurrency = 1;
    c.enqueueFolder("/up", folderItems() as any);
    await vi.waitFor(() => expect(c.queue.items[0].status).toBe("done"));
    expect(up.fsUploadBatch).toHaveBeenCalledTimes(1);
    expect(up.fsUpload).not.toHaveBeenCalled();
    const args = vi.mocked(up.fsUploadBatch).mock.calls[0];
    expect(args[1]).toBe("/up");
    expect((args[2] as any[]).map((e) => e.relativePath)).toEqual(["a.txt", "sub/b.txt", "sub/deep/c.txt"]);
  });

  it("儲存不支援批次時退回逐檔上傳", async () => {
    c.queue.concurrency = 1;
    vi.mocked(up.fsUploadBatch).mockRejectedValueOnce(Object.assign(new Error("不支援批次"), { code: "batch_unsupported" }));
    c.enqueueFolder("/up", folderItems() as any);
    await vi.waitFor(() => expect(c.queue.items[0].status).toBe("done"));
    expect(up.fsUploadBatch).toHaveBeenCalledTimes(1);
    // 逐檔退回：每檔各呼叫一次 fsUpload，目標目錄依相對路徑展開
    expect(up.fsUpload).toHaveBeenCalledTimes(3);
    const dirs = vi.mocked(up.fsUpload).mock.calls.map((a) => a[1]);
    expect(dirs).toEqual(["/up", "/up/sub", "/up/sub/deep"]);
  });
});
