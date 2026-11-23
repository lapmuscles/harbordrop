import { describe, expect, it } from "vitest";
import { huggingfaceDriver, UPLOAD_REPO } from "../src/storage/drivers/huggingface";
import type { UploadSessionView } from "../src/storage/types";

const TOKEN = "hf_REALTOKEN_never_leak";
const OID_A = "a".repeat(64);
const OID_B = "b".repeat(64);

// 兩檔：a.txt 10 位元組、b.txt 20 位元組
const FILES = [
  { clientPath: "a.txt", repoPath: "pre/x/a.txt", rel: "/x/a.txt", filename: "a.txt", vpath: "/m/x/a.txt", size: 10 },
  { clientPath: "b.txt", repoPath: "pre/x/b.txt", rel: "/x/b.txt", filename: "b.txt", vpath: "/m/x/b.txt", size: 20 },
];
const BY_REPO: Record<string, { size: number; oid: string }> = {
  "pre/x/a.txt": { size: 10, oid: OID_A },
  "pre/x/b.txt": { size: 20, oid: OID_B },
};

function mockFetch(calls: { url: string; init: RequestInit; body?: string }[]) {
  return (async (url: string, init: RequestInit = {}) => {
    const body = init.body ? String(init.body) : undefined;
    calls.push({ url, init, body });
    if (url.endsWith(".git/info/lfs/objects/batch")) {
      const req = JSON.parse(body ?? "{}");
      return Response.json({
        transfer: "xet",
        objects: req.objects.map((o: any) => ({
          oid: o.oid,
          size: o.size,
          actions: {
            upload: { href: "https://huggingface.co/api/datasets/u/r/xet-write-token/main", header: { "X-Xet-Cas-Url": "https://cas", "X-Xet-Access-Token": "jwt", "X-Xet-Token-Expiration": "1" } },
            verify: { href: "https://huggingface.co/u/r.git/info/lfs/objects/verify", header: { Authorization: `Bearer ${TOKEN}` } },
          },
        })),
      });
    }
    if (url.includes("/xet-write-token/")) return Response.json({ accessToken: "jwt2", casUrl: "https://cas", exp: 123 });
    if (url.includes("/commit/")) return Response.json({ commitOid: "batch1", commitUrl: "u" });
    if (url.includes("/paths-info/")) {
      const params = new URLSearchParams(body ?? "");
      const p = params.get("paths") ?? "";
      const info = BY_REPO[p];
      if (!info) return Response.json([]);
      return Response.json([{ type: "file", path: p, size: info.size, lfs: { oid: info.oid, size: info.size } }]);
    }
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
}

function make() {
  const calls: { url: string; init: RequestInit; body?: string }[] = [];
  const d = huggingfaceDriver.create({ repo: "u/r", repoType: "dataset", pathPrefix: "/pre", token: TOKEN }, { platform: "node", fetch: mockFetch(calls) });
  return { d, calls };
}

const session = (meta: Record<string, unknown> = {}): UploadSessionView => ({
  id: "sid",
  protocol: "xet",
  objectPath: "/x",
  filename: "batch",
  size: 30,
  meta: { batch: true, files: FILES.map((f) => ({ ...f })), ...meta },
  state: "init",
});
const req = (method: string, body?: unknown) =>
  new Request("http://h/x", { method, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const input = (sub: string, r: Request) => ({ subpath: sub, request: r, origin: "http://h", actionBase: "http://h/api/uploads/sid/action" });

describe("HuggingFace 批次上傳（一次 commit）", () => {
  it("preupload：多檔路徑逐一核對，錯的路徑拒絕", async () => {
    const { d } = make();
    const ok = await d.uploadAction!(session(), "hub", input("api/datasets/harbordrop/upload/preupload/main", req("POST", { files: [{ path: "a.txt" }, { path: "b.txt" }] })));
    const j: any = await ok.response.json();
    expect(j.files).toEqual([
      { path: "a.txt", uploadMode: "lfs", shouldIgnore: false },
      { path: "b.txt", uploadMode: "lfs", shouldIgnore: false },
    ]);
    await expect(d.uploadAction!(session(), "hub", input("api/datasets/harbordrop/upload/preupload/main", req("POST", { files: [{ path: "a.txt" }, { path: "evil.txt" }] })))).rejects.toThrow("上傳路徑不符");
  });

  it("LFS batch：多個物件一次轉送，權杖清掉，oid 登記進 meta.batches", async () => {
    const { d, calls } = make();
    const r = await d.uploadAction!(session(), "hub", input("datasets/harbordrop/upload.git/info/lfs/objects/batch", req("POST", { objects: [{ oid: OID_A, size: 10 }, { oid: OID_B, size: 20 }] })));
    const j: any = await r.response.json();
    expect(j.objects.map((o: any) => o.oid)).toEqual([OID_A, OID_B]);
    expect(JSON.stringify(j)).not.toContain(TOKEN);
    expect(r.meta).toEqual({ batches: [{ oid: OID_A, size: 10 }, { oid: OID_B, size: 20 }], transfer: "xet" });
    expect(r.state).toBe("uploading");
    // 後端只打一次 HF batch，帶兩個物件
    const batchCalls = calls.filter((c) => c.url.endsWith(".git/info/lfs/objects/batch"));
    expect(batchCalls).toHaveLength(1);
    expect(JSON.parse(batchCalls[0].body ?? "{}").objects).toHaveLength(2);
  });

  it("LFS batch：大小對不上批次檔案就拒絕", async () => {
    const { d } = make();
    await expect(
      d.uploadAction!(session(), "hub", input("datasets/harbordrop/upload.git/info/lfs/objects/batch", req("POST", { objects: [{ oid: OID_A, size: 99 }] }))),
    ).rejects.toThrow("檔案大小與上傳工作階段不符");
  });

  it("commit：兩檔一次 HF commit，sha256 填回 meta.files", async () => {
    const { d, calls } = make();
    const s = session({ batches: [{ oid: OID_A, size: 10 }, { oid: OID_B, size: 20 }] });
    const ndjson = [
      JSON.stringify({ key: "header", value: { summary: "t" } }),
      JSON.stringify({ key: "lfsFile", value: { path: "a.txt", algo: "sha256", size: 10, oid: OID_A } }),
      JSON.stringify({ key: "lfsFile", value: { path: "b.txt", algo: "sha256", size: 20, oid: OID_B } }),
    ].join("\n");
    const r = await d.uploadAction!(s, "hub", input("api/datasets/harbordrop/upload/commit/main", req("POST", ndjson)));
    expect(r.state).toBe("committed");
    const files = (r.meta as any).files;
    expect(files.map((f: any) => f.sha256)).toEqual([OID_A, OID_B]);
    expect((r.meta as any).commitOid).toBe("batch1");
    // 後端只打一次 HF commit，內含兩個 lfsFile
    const commitCalls = calls.filter((c) => c.url.includes("/commit/"));
    expect(commitCalls).toHaveLength(1);
    const lines = (commitCalls[0].body ?? "").split("\n").map((l) => JSON.parse(l));
    const lfs = lines.filter((l: any) => l.key === "lfsFile");
    expect(lfs).toHaveLength(2);
    expect(lfs.map((l: any) => l.value.path)).toEqual(["pre/x/a.txt", "pre/x/b.txt"]);
  });

  it("commit：oid 沒在 LFS batch 登記過就拒絕、不提交", async () => {
    const { d, calls } = make();
    const s = session({ batches: [{ oid: OID_A, size: 10 }] }); // 缺 b.txt 的 batch
    const ndjson = [
      JSON.stringify({ key: "header", value: { summary: "t" } }),
      JSON.stringify({ key: "lfsFile", value: { path: "a.txt", algo: "sha256", size: 10, oid: OID_A } }),
      JSON.stringify({ key: "lfsFile", value: { path: "b.txt", algo: "sha256", size: 20, oid: OID_B } }),
    ].join("\n");
    await expect(d.uploadAction!(s, "hub", input("api/datasets/harbordrop/upload/commit/main", req("POST", ndjson)))).rejects.toThrow("sha256 或大小與 LFS batch 不符");
    expect(calls.filter((c) => c.url.includes("/commit/"))).toHaveLength(0);
  });

  it("commit：檔案數量不符就拒絕", async () => {
    const { d } = make();
    const s = session({ batches: [{ oid: OID_A, size: 10 }, { oid: OID_B, size: 20 }] });
    const ndjson = [
      JSON.stringify({ key: "header", value: { summary: "t" } }),
      JSON.stringify({ key: "lfsFile", value: { path: "a.txt", algo: "sha256", size: 10, oid: OID_A } }),
    ].join("\n");
    await expect(d.uploadAction!(s, "hub", input("api/datasets/harbordrop/upload/commit/main", req("POST", ndjson)))).rejects.toThrow("commit 檔案數量與批次不符");
  });

  it("commit：同名 clientPath 重複就拒絕、不提交（去重失敗時的防線）", async () => {
    const { d, calls } = make();
    const s = session({ batches: [{ oid: OID_A, size: 10 }, { oid: OID_B, size: 20 }] });
    const ndjson = [
      JSON.stringify({ key: "header", value: { summary: "t" } }),
      JSON.stringify({ key: "lfsFile", value: { path: "a.txt", algo: "sha256", size: 10, oid: OID_A } }),
      JSON.stringify({ key: "lfsFile", value: { path: "a.txt", algo: "sha256", size: 20, oid: OID_B } }),
    ].join("\n");
    await expect(d.uploadAction!(s, "hub", input("api/datasets/harbordrop/upload/commit/main", req("POST", ndjson)))).rejects.toThrow("commit 內容不符");
    expect(calls.filter((c) => c.url.includes("/commit/"))).toHaveLength(0);
  });

  it("completeBatchUpload：逐檔驗證大小與 sha256，回傳所有 entry", async () => {
    const { d } = make();
    const s = session({
      commitOid: "batch1",
      files: FILES.map((f, i) => ({ ...f, sha256: i === 0 ? OID_A : OID_B })),
    });
    const r = await d.completeBatchUpload!(s);
    expect(r.entries.map((e) => e.path)).toEqual(["/x/a.txt", "/x/b.txt"]);
    expect(r.entries.map((e) => e.sha256)).toEqual([OID_A, OID_B]);
  });

  it("completeBatchUpload：未提交就拒絕", async () => {
    const { d } = make();
    await expect(d.completeBatchUpload!(session())).rejects.toThrow("尚未提交");
  });
});
