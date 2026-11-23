import { describe, expect, it } from "vitest";
import { HdClient, PROTOCOLS, collectFolderFiles, newFolderGroupId, uploadFolder, type FolderItem } from "../src/upload";

/** 假後端：init 回 protocol=fake，complete 回分享連結；記錄每次 init 的 body */
function fakeApi() {
  const inits: any[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/api/uploads") && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      inits.push(body);
      return Response.json({ sessionId: `s${inits.length}`, uploadToken: "t", protocol: "fake", client: {} }, { status: 201 });
    }
    const m = /\/api\/uploads\/(s\d+)\/complete$/.exec(url);
    if (m) {
      return Response.json({
        share: { slug: `slug-${m[1]}`, filename: "x", size: 1, mime: null, sha256: null, expiresAt: null, maxViews: null, views: 0, createdAt: 0, passwordRequired: false, previewKind: "none" },
        url: `http://h/f/slug-${m[1]}`,
      });
    }
    return new Response("?", { status: 404 });
  }) as typeof fetch;
  return { f, inits };
}

const FAKE_STATS = { protocol: "fake", attempts: [], skipped: 0, startedAt: Date.now() };

describe("collectFolderFiles", () => {
  it("用 webkitRelativePath；缺失時退回檔名；反斜線轉正斜線", () => {
    const mk = (name: string, rel?: string) => {
      const f = new File(["x"], name) as File & { webkitRelativePath?: string };
      if (rel !== undefined) Object.defineProperty(f, "webkitRelativePath", { value: rel });
      return f;
    };
    const items = collectFolderFiles([mk("a.txt", "photos/a.txt"), mk("b.txt"), mk("c.txt", "win\\sub\\c.txt")]);
    expect(items.map((i) => i.relativePath)).toEqual(["photos/a.txt", "b.txt", "win/sub/c.txt"]);
  });
});

describe("newFolderGroupId", () => {
  it("16 字元小寫十六進位，每次不同", () => {
    const a = newFolderGroupId();
    const b = newFolderGroupId();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});

describe("uploadFolder", () => {
  it("逐檔上傳：relativePath 與共用 groupId 傳給 init，自訂 slug 被忽略", async () => {
    const srv = fakeApi();
    const api = new HdClient({ baseUrl: "http://h", fetch: srv.f });
    PROTOCOLS["fake"] = async (_api, _s, file, hooks) => {
      hooks.onProgress?.({ phase: "uploading", fraction: 1, loaded: file.size, total: file.size });
      return { stats: FAKE_STATS, completeBody: {} };
    };
    const items: FolderItem[] = [
      { file: new Blob(["aa"]), relativePath: "photos/a.txt" },
      { file: new Blob(["bbb"]), relativePath: "photos/sub/b.txt" },
    ];
    const starts: string[] = [];
    const dones: string[] = [];
    const overalls: { loaded: number; total: number }[] = [];
    const r = await uploadFolder(api, items, {
      storageId: 1,
      groupId: "grp123",
      share: { slug: "my-slug", password: "pw" },
      onFileStart: (it) => starts.push(it.relativePath),
      onFileDone: (it) => dones.push(it.relativePath),
      onOverallProgress: (o) => overalls.push({ loaded: o.loaded, total: o.total }),
    });
    expect(r.aborted).toBe(false);
    expect(r.failed).toEqual([]);
    expect(r.done.map((d) => d.res.url)).toEqual(["http://h/f/slug-s1", "http://h/f/slug-s2"]);
    expect(starts).toEqual(["photos/a.txt", "photos/sub/b.txt"]);
    expect(dones).toEqual(["photos/a.txt", "photos/sub/b.txt"]);
    expect(srv.inits).toHaveLength(2);
    expect(srv.inits[0]).toMatchObject({ filename: "a.txt", relativePath: "photos/a.txt", groupId: "grp123" });
    expect(srv.inits[1]).toMatchObject({ filename: "b.txt", relativePath: "photos/sub/b.txt", groupId: "grp123" });
    expect(srv.inits[0].share.slug).toBeUndefined();
    expect(srv.inits[0].share.password).toBe("pw");
    expect(overalls.at(-1)).toEqual({ loaded: 5, total: 5 });
  });

  it("單檔失敗不中斷其餘檔案；失敗記入 failed", async () => {
    const srv = fakeApi();
    const api = new HdClient({ baseUrl: "http://h", fetch: srv.f });
    PROTOCOLS["fake"] = async (_api, _s, file) => {
      if (file.size === 7) throw new Error("boom");
      return { stats: FAKE_STATS, completeBody: {} };
    };
    const items: FolderItem[] = [
      { file: new Blob(["aa"]), relativePath: "a.txt" },
      { file: new Blob(["1234567"]), relativePath: "bad.txt" },
      { file: new Blob(["ccc"]), relativePath: "c.txt" },
    ];
    const errors: string[] = [];
    const r = await uploadFolder(api, items, { storageId: 1, onFileError: (it, _i, e) => errors.push(`${it.relativePath}:${e.message}`) });
    expect(r.done.map((d) => d.item.relativePath)).toEqual(["a.txt", "c.txt"]);
    expect(r.failed.map((f) => f.item.relativePath)).toEqual(["bad.txt"]);
    expect(errors).toEqual(["bad.txt:boom"]);
    expect(r.aborted).toBe(false);
  });

  it("取消時停止迴圈，回傳 aborted 與已完成的檔案", async () => {
    const srv = fakeApi();
    const api = new HdClient({ baseUrl: "http://h", fetch: srv.f });
    PROTOCOLS["fake"] = async () => ({ stats: FAKE_STATS, completeBody: {} });
    const ctrl = new AbortController();
    const items: FolderItem[] = [
      { file: new Blob(["a"]), relativePath: "a.txt" },
      { file: new Blob(["b"]), relativePath: "b.txt" },
      { file: new Blob(["c"]), relativePath: "c.txt" },
    ];
    const r = await uploadFolder(api, items, {
      storageId: 1,
      signal: ctrl.signal,
      onFileDone: (_it, i) => {
        if (i === 0) ctrl.abort();
      },
    });
    expect(r.aborted).toBe(true);
    expect(r.done.map((d) => d.item.relativePath)).toEqual(["a.txt"]);
    expect(r.failed).toEqual([]);
    expect(srv.inits).toHaveLength(1);
  });

  it("空清單直接回傳空結果", async () => {
    const srv = fakeApi();
    const api = new HdClient({ baseUrl: "http://h", fetch: srv.f });
    const r = await uploadFolder(api, [], { storageId: 1 });
    expect(r).toEqual({ done: [], failed: [], aborted: false });
    expect(srv.inits).toHaveLength(0);
  });
});
