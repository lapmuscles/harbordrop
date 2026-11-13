import { describe, expect, it } from "vitest";
import { huggingfaceDriver, UPLOAD_REPO } from "../src/storage/drivers/huggingface";
import type { UploadSessionView } from "../src/storage/types";

const TOKEN = "hf_REALTOKEN_never_leak";
const OID = "a".repeat(64);

function mockFetch(calls: { url: string; init: RequestInit }[]) {
  return (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith(".git/info/lfs/objects/batch"))
      return Response.json({
        transfer: "xet",
        objects: [
          {
            oid: OID,
            size: 10,
            actions: {
              upload: { href: "https://huggingface.co/api/datasets/u/r/xet-write-token/main", header: { "X-Xet-Cas-Url": "https://cas", "X-Xet-Access-Token": "jwt", "X-Xet-Token-Expiration": "1", "X-Xet-Session-Id": "S" } },
              verify: { href: "https://huggingface.co/u/r.git/info/lfs/objects/verify", header: { Authorization: `Bearer ${TOKEN}` } },
            },
          },
        ],
      });
    if (url.includes("/xet-write-token/")) return Response.json({ accessToken: "jwt2", casUrl: "https://cas", exp: 123 });
    if (url.includes("/commit/")) return Response.json({ commitOid: "c0ffee", commitUrl: "u" });
    if (url.includes("/paths-info/")) return Response.json([{ type: "file", path: "pre/x/f.bin", size: 10, lfs: { oid: OID, size: 10 } }]);
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
}

function make() {
  const calls: { url: string; init: RequestInit }[] = [];
  const d = huggingfaceDriver.create({ repo: "u/r", repoType: "dataset", pathPrefix: "/pre", token: TOKEN }, { platform: "node", fetch: mockFetch(calls) });
  return { d, calls };
}

const session = (meta: Record<string, unknown> = {}): UploadSessionView => ({
  id: "sid",
  protocol: "xet",
  objectPath: "/x/f.bin",
  filename: "f.bin",
  size: 10,
  meta: { clientPath: "f.bin", repoPath: "pre/x/f.bin", ...meta },
  state: "init",
});
const req = (method: string, body?: unknown) => new Request("http://h/x", { method, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const input = (sub: string, r: Request) => ({ subpath: sub, request: r, origin: "http://h", actionBase: "http://h/api/uploads/sid/action" });

describe("HuggingFace hub 代理", () => {
  it("initUpload 不暴露真實倉庫", async () => {
    const { d } = make();
    const r = await d.initUpload!({ path: "/x/f.bin", filename: "f.bin", size: 10 });
    expect(r.protocol).toBe("xet");
    expect(JSON.stringify(r.client)).not.toContain("u/r");
    expect(r.client.repo).toBe(UPLOAD_REPO);
  });

  it("LFS batch：移除 verify 中的 HF token 與 xet 權杖，href 改指向後端 xet-token", async () => {
    const { d, calls } = make();
    const res = await d.uploadAction!(session(), "hub", input(`datasets/${UPLOAD_REPO}.git/info/lfs/objects/batch`, req("POST", { objects: [{ oid: OID, size: 10 }] })));
    const text = await res.response.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("jwt");
    const j = JSON.parse(text);
    expect(j.objects[0].actions.verify).toBeUndefined();
    expect(j.objects[0].actions.upload.href).toBe("http://h/api/uploads/sid/action/xet-token");
    expect(j.objects[0].actions.upload.header["X-Xet-Session-Id"]).toBe("S");
    expect(res.meta).toMatchObject({ sha256: OID });
    // 後端送往 HF 時帶 token
    expect((calls[0].init.headers as any).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("LFS batch 拒絕大小不符或多檔", async () => {
    const { d } = make();
    await expect(d.uploadAction!(session(), "hub", input(`datasets/${UPLOAD_REPO}.git/info/lfs/objects/batch`, req("POST", { objects: [{ oid: OID, size: 11 }] })))).rejects.toThrow();
    await expect(
      d.uploadAction!(session(), "hub", input(`datasets/${UPLOAD_REPO}.git/info/lfs/objects/batch`, req("POST", { objects: [{ oid: OID, size: 10 }, { oid: OID, size: 10 }] }))),
    ).rejects.toThrow();
  });

  it("xet-token 由後端換發", async () => {
    const { d } = make();
    const res = await d.uploadAction!(session(), "xet-token", input("", req("GET")));
    expect(await res.response.json()).toEqual({ accessToken: "jwt2", casUrl: "https://cas", exp: 123 });
  });

  it("commit：後端自行組 commit 到真實路徑；sha256 不符則拒絕", async () => {
    const { d, calls } = make();
    const nd = (oid: string) => [JSON.stringify({ key: "header", value: { summary: "x" } }), JSON.stringify({ key: "lfsFile", value: { path: "f.bin", algo: "sha256", size: 10, oid } })].join("\n");
    await expect(d.uploadAction!(session({ sha256: OID }), "hub", input(`api/datasets/${UPLOAD_REPO}/commit/main`, req("POST", nd("b".repeat(64)))))).rejects.toThrow();
    const res = await d.uploadAction!(session({ sha256: OID }), "hub", input(`api/datasets/${UPLOAD_REPO}/commit/main`, req("POST", nd(OID))));
    expect(res.state).toBe("committed");
    const commitCall = calls.find((c) => c.url.includes("/commit/"))!;
    expect(commitCall.url).toBe("https://huggingface.co/api/datasets/u/r/commit/main");
    expect(String(commitCall.init.body)).toContain('"path":"pre/x/f.bin"');
  });

  it("代理拒絕白名單以外的請求", async () => {
    const { d } = make();
    await expect(d.uploadAction!(session(), "hub", input("api/datasets/u/r/delete", req("POST", {})))).rejects.toThrow(/代理不允許/);
  });

  it("completeUpload 驗證倉庫中的大小與 sha256", async () => {
    const { d } = make();
    await expect(d.completeUpload!(session({ sha256: OID }), {})).rejects.toThrow(); // 未 commit
    const r = await d.completeUpload!(session({ sha256: OID, commitOid: "c" }), {});
    expect(r.entry).toMatchObject({ size: 10, sha256: OID });
  });
});
