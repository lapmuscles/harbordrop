import { describe, expect, it } from "vitest";
import { onedriveDriver, graphChunkSize, OneDriveDriver } from "../src/storage/drivers/onedrive";
import { gdriveDriver, gdriveChunkSize } from "../src/storage/drivers/gdrive";
import type { UploadSessionView } from "../src/storage/types";
import { makeApp } from "./helpers/app";

type Call = { url: string; method: string; headers: Headers; body: any };
const SECRET = "client-secret-never-leak";
const REFRESH = "refresh-token-never-leak";

function recorder(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
  return { f, calls };
}

const tokenResponse = () => Response.json({ access_token: "AT", expires_in: 3600 });
const session = (over: Partial<UploadSessionView>): UploadSessionView => ({ id: "sid", protocol: "x", objectPath: "/2026/a.bin", filename: "a.bin", size: 10, meta: {}, state: "init", ...over });

// ———————————————————— OneDrive ————————————————————
describe("onedrive 驅動", () => {
  const G = "https://graph.microsoft.com/v1.0/me/drive";
  function make(cfg: Record<string, unknown> = {}, extra?: (c: Call) => Response | undefined) {
    const rec = recorder((c) => {
      if (c.url.includes("/oauth2/v2.0/token")) return tokenResponse();
      const r = extra?.(c);
      if (r) return r;
      if (c.url === `${G}/root:/HD/2026/a.bin:/createUploadSession`) return Response.json({ uploadUrl: "https://up.onedrive/sess", expirationDateTime: "2030-01-01T00:00:00Z" });
      if (c.url === `${G}/root:/HD/2026/a.bin:`) return Response.json({ id: "I", name: "a.bin", size: 10, file: { mimeType: "application/octet-stream" }, "@microsoft.graph.downloadUrl": "https://dl.onedrive/x" });
      if (c.url.startsWith(`${G}/root:/HD/dir:/children`)) return Response.json({ value: [{ name: "f.txt", size: 3, file: {} }, { name: "sub", folder: {} }], "@odata.nextLink": `https://graph.microsoft.com/v1.0/next?x=1` });
      if (c.url === G) return Response.json({ id: "DRIVE", driveType: "personal", quota: { used: 1, total: 2 } });
      return new Response(JSON.stringify({ error: { message: "nf" } }), { status: 404 });
    });
    const d = onedriveDriver.create({ clientId: "cid", clientSecret: SECRET, refreshToken: REFRESH, root: "/HD", ...cfg }, { platform: "node", fetch: rec.f }) as OneDriveDriver;
    return { d, calls: rec.calls };
  }

  it("分片大小為 320 KiB 倍數", () => {
    expect(graphChunkSize(10 * 1024 * 1024) % (320 * 1024)).toBe(0);
    expect(graphChunkSize(100)).toBe(320 * 1024);
    expect(graphChunkSize(200 * 1024 * 1024)).toBeLessThanOrEqual(60 * 1024 * 1024);
  });

  it("refresh_token 換 access token 並快取；cn 區使用世紀互聯端點", async () => {
    const { d, calls } = make();
    await d.stat("/2026/a.bin");
    await d.stat("/2026/a.bin");
    const tok = calls.filter((c) => c.url.includes("/token"));
    expect(tok.length).toBe(1);
    expect(tok[0].url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(String(tok[0].body)).toContain("grant_type=refresh_token");
    expect(calls[1].headers.get("authorization")).toBe("Bearer AT");

    const cn = make({ region: "cn", driveType: "business" });
    await cn.d.testConnection();
    expect(cn.calls[0].url).toBe("https://login.chinacloudapi.cn/organizations/oauth2/v2.0/token");
    expect(cn.calls[1].url).toBe("https://microsoftgraph.chinacloudapi.cn/v1.0/me/drive");
  });

  it("401 會重新換取權杖後重試", async () => {
    let n = 0;
    const { d, calls } = make({}, (c) => (c.url === `${G}/root:/HD/x:` && n++ === 0 ? new Response("", { status: 401 }) : undefined));
    expect(await d.stat("/x")).toBeNull();
    expect(calls.filter((c) => c.url.includes("/token")).length).toBe(2);
  });

  it("list 對應路徑與游標；download 轉址", async () => {
    const { d } = make();
    const l = await d.list("/dir");
    expect(l.entries.map((e) => [e.path, e.isDir])).toEqual([["/dir/f.txt", false], ["/dir/sub", true]]);
    expect(l.cursor).toContain("graph.microsoft.com");
    await expect(d.list("/dir", { cursor: "https://evil.example/x" })).rejects.toThrow("游標");
    const t = await d.download("/2026/a.bin");
    expect(t).toMatchObject({ kind: "redirect", url: "https://dl.onedrive/x" });
  });

  it("initUpload 建立上傳工作階段，回傳 uploadUrl 但不含憑證", async () => {
    const { d, calls } = make();
    const r = await d.initUpload({ path: "/2026/a.bin", filename: "a.bin", size: 5_000_000, mime: "application/octet-stream" });
    expect(r.protocol).toBe("graph-upload-session");
    expect(r.client.uploadUrl).toBe("https://up.onedrive/sess");
    expect((r.client.chunkSize as number) % (320 * 1024)).toBe(0);
    const s = JSON.stringify(r);
    expect(s).not.toContain(SECRET);
    expect(s).not.toContain(REFRESH);
    expect(s).not.toContain("AT");
    expect(calls.find((c) => c.url.endsWith("createUploadSession"))!.method).toBe("POST");
  });

  it("completeUpload 驗證大小；abortUpload 刪除工作階段", async () => {
    const { d, calls } = make();
    expect((await d.completeUpload(session({ size: 10 }))).entry.size).toBe(10);
    await expect(d.completeUpload(session({ size: 11 }))).rejects.toThrow("大小不符");
    await d.abortUpload(session({ meta: { uploadUrl: "https://up.onedrive/sess" } }));
    expect(calls.at(-1)).toMatchObject({ url: "https://up.onedrive/sess", method: "DELETE" });
    expect(calls.at(-1)!.headers.get("authorization")).toBeNull();
  });

  it("delete / mkdir（含 409 已存在）/ rename / copy（輪詢監控網址）", async () => {
    const { d, calls } = make({}, (c) => {
      if (c.method === "DELETE") return new Response(null, { status: 204 });
      if (c.method === "POST" && c.url === `${G}/root:/HD:/children`) return Response.json({ error: { code: "nameAlreadyExists" } }, { status: 409 });
      if (c.url === `${G}/root:/HD/new:`) return Response.json({ id: "NEWDIR", name: "new", folder: {} });
      if (c.url === `${G}/root:/HD:`) return Response.json({ id: "HDROOT", name: "HD", folder: {} });
      if (c.method === "POST" && c.url === `${G}/root:/HD/new:/children`) return Response.json({ error: {} }, { status: 409 });
      if (c.method === "PATCH") return Response.json({ id: "I" });
      if (c.url.includes(":/copy")) return new Response(null, { status: 202, headers: { location: "https://monitor/1" } });
      if (c.url === "https://monitor/1") return Response.json({ status: "completed", resourceId: "R" });
      return undefined;
    });
    d.copyPollMs = 1;
    await d.delete(["/2026/a.bin"]);
    expect(calls.some((c) => c.method === "DELETE" && c.url === `${G}/root:/HD/2026/a.bin:`)).toBe(true);
    await expect(d.delete(["/"])).rejects.toThrow("根目錄");
    await d.mkdir("/new");
    await d.rename("/2026/a.bin", "/new/b.bin");
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(JSON.parse(patch.body)).toEqual({ name: "b.bin", parentReference: { id: "NEWDIR" } });
    await d.copy("/2026/a.bin", "/new/c.bin");
    const cp = calls.find((c) => c.url.includes(":/copy"))!;
    expect(JSON.parse(cp.body)).toEqual({ parentReference: { driveId: "DRIVE", id: "NEWDIR" }, name: "c.bin" });
  });
});

// ———————————————————— Google Drive ————————————————————
describe("gdrive 驅動", () => {
  const API = "https://www.googleapis.com/drive/v3";
  /** 簡易 Drive 樹：ROOT ─ 2026(D26) ─ a.bin(F1, 10 bytes) */
  const tree: Record<string, any> = {
    ROOT: { id: "ROOT", name: "我的雲端硬碟", mimeType: "application/vnd.google-apps.folder" },
    D26: { id: "D26", name: "2026", mimeType: "application/vnd.google-apps.folder", parents: ["ROOT"] },
    F1: { id: "F1", name: "a.bin", mimeType: "application/octet-stream", size: "10", parents: ["D26"] },
  };
  function make(extra?: (c: Call) => Response | undefined) {
    const rec = recorder((c) => {
      if (c.url === "https://oauth2.googleapis.com/token") return tokenResponse();
      const r = extra?.(c);
      if (r) return r;
      const u = new URL(c.url);
      if (u.pathname === "/drive/v3/files" && c.method === "GET") {
        const q = u.searchParams.get("q")!;
        const parent = /'([^']+)' in parents/.exec(q)![1];
        const name = /name = '([^']+)'/.exec(q)?.[1];
        const files = Object.values(tree).filter((f) => f.parents?.includes(parent) && (!name || f.name === name));
        return Response.json({ files });
      }
      const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
      if (m && c.method === "GET" && !u.searchParams.has("alt")) return tree[m[1]] ? Response.json(tree[m[1]]) : new Response("{}", { status: 404 });
      if (m && u.searchParams.get("alt") === "media")
        return new Response("0123456789".slice(2, 5), { status: 206, headers: { "content-range": "bytes 2-4/10", "content-length": "3", "content-type": "application/octet-stream" } });
      if (u.pathname.startsWith("/upload/drive/v3/files") && u.searchParams.get("uploadType") === "resumable")
        return new Response(null, { status: 200, headers: { location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=X" } });
      return new Response(JSON.stringify({ error: { message: "nf" } }), { status: 404 });
    });
    const d = gdriveDriver.create({ clientId: "cid", clientSecret: SECRET, refreshToken: REFRESH, rootFolderId: "ROOT" }, { platform: "node", fetch: rec.f });
    return { d, calls: rec.calls };
  }

  it("分片大小為 256 KiB 倍數", () => {
    expect(gdriveChunkSize(8 * 1024 * 1024) % (256 * 1024)).toBe(0);
    expect(gdriveChunkSize(1)).toBe(256 * 1024);
  });

  it("路徑解析、list、stat", async () => {
    const { d } = make();
    expect(await d.stat("/2026/a.bin")).toMatchObject({ name: "a.bin", size: 10, isDir: false, path: "/2026/a.bin" });
    expect(await d.stat("/nope/x")).toBeNull();
    const l = await d.list!("/2026");
    expect(l.entries.map((e) => e.path)).toEqual(["/2026/a.bin"]);
  });

  it("download 經後端串流並轉送 Range", async () => {
    const { d, calls } = make();
    const t = await d.download("/2026/a.bin", { request: new Request("http://x", { headers: { range: "bytes=2-4" } }), filename: "中文.bin" });
    expect(t.kind).toBe("response");
    const res = (t as any).response as Response;
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(await res.text()).toBe("234");
    const media = calls.find((c) => c.url.includes("alt=media"))!;
    expect(media.headers.get("range")).toBe("bytes=2-4");
    expect(media.headers.get("authorization")).toBe("Bearer AT");
  });

  it("initUpload 帶上瀏覽器 Origin 建立 resumable session，回傳不含憑證", async () => {
    const { d, calls } = make();
    const r = await d.initUpload!({ path: "/2026/new.bin", filename: "new.bin", size: 1000, mime: "application/octet-stream", origin: "https://drop.example.com" });
    expect(r.protocol).toBe("gdrive-resumable");
    expect(r.client.uploadUrl).toContain("upload_id=X");
    const init = calls.find((c) => c.url.includes("uploadType=resumable"))!;
    expect(init.method).toBe("POST");
    expect(init.headers.get("origin")).toBe("https://drop.example.com");
    expect(init.headers.get("x-upload-content-length")).toBe("1000");
    expect(JSON.parse(init.body)).toEqual({ name: "new.bin", parents: ["D26"], mimeType: "application/octet-stream" });
    const s = JSON.stringify({ client: r.client });
    expect(s).not.toContain(SECRET);
    expect(s).not.toContain(REFRESH);
    // 既有檔案 → PATCH 覆寫
    await d.initUpload!({ path: "/2026/a.bin", filename: "a.bin", size: 10, origin: "https://o" });
    expect(calls.filter((c) => c.url.includes("uploadType=resumable")).at(-1)!.url).toContain("/files/F1?");
  });

  it("completeUpload 驗證 id 屬於目的位置且大小相符", async () => {
    const { d } = make();
    const ok = await d.completeUpload!(session({ objectPath: "/2026/a.bin", size: 10, meta: { parentId: "D26" } }), { id: "F1" });
    expect(ok.entry).toMatchObject({ path: "/2026/a.bin", size: 10 });
    await expect(d.completeUpload!(session({ objectPath: "/2026/a.bin", size: 99, meta: { parentId: "D26" } }), { id: "F1" })).rejects.toThrow("大小不符");
    // 瀏覽器亂給 id：退回以路徑解析
    const fb = await d.completeUpload!(session({ objectPath: "/2026/a.bin", size: 10, meta: { parentId: "OTHER" } }), { id: "D26" });
    expect(fb.entry.path).toBe("/2026/a.bin");
  });

  it("delete 移至垃圾桶、mkdir、rename 跨資料夾、copy", async () => {
    const { d, calls } = make((c) => {
      if (c.method === "PATCH") return Response.json({ ...tree.F1 });
      if (c.method === "POST" && c.url.startsWith(`${API}/files?`)) return Response.json({ id: "NEW", name: JSON.parse(c.body).name, mimeType: "application/vnd.google-apps.folder" });
      if (c.method === "POST" && c.url.includes("/copy")) return Response.json({ id: "CP", name: "c.bin" });
      return undefined;
    });
    await d.delete!(["/2026/a.bin"]);
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body)).toEqual({ trashed: true });
    await d.mkdir!("/x");
    expect(JSON.parse(calls.find((c) => c.method === "POST" && c.url.startsWith(`${API}/files?`))!.body)).toMatchObject({ name: "x", parents: ["ROOT"] });
    await d.rename!("/2026/a.bin", "/x/b.bin");
    const mv = calls.filter((c) => c.method === "PATCH").at(-1)!;
    expect(mv.url).toContain("addParents=NEW");
    expect(mv.url).toContain("removeParents=D26");
    expect(JSON.parse(mv.body)).toEqual({ name: "b.bin" });
    await d.copy!("/2026/a.bin", "/x/c.bin");
    expect(JSON.parse(calls.find((c) => c.url.includes("/copy"))!.body)).toEqual({ name: "c.bin", parents: ["NEW"] });
    await expect(d.copy!("/2026", "/y")).rejects.toThrow("資料夾");
  });

  it("未設定 refresh token 時回報需要授權", async () => {
    const d = gdriveDriver.create({ clientId: "cid", clientSecret: SECRET }, { platform: "node", fetch: (async () => new Response("")) as any });
    const t = await d.testConnection();
    expect(t.ok).toBe(false);
    expect(t.message).toContain("尚未授權");
  });
});

// ———————————————————— OAuth 路由 ————————————————————
describe("儲存 OAuth 授權路由", () => {
  async function setup() {
    const h = await makeApp({ PUBLIC_URL: "https://drop.example.com" });
    const tokenCalls: string[] = [];
    h.ctx.driverCtx.fetch = (async (url: string, init: RequestInit = {}) => {
      tokenCalls.push(String(init.body));
      return Response.json({ access_token: "AT", refresh_token: "NEW_REFRESH_TOKEN", expires_in: 3600 });
    }) as typeof fetch;
    const auth = { authorization: `Bearer ${await h.login()}` };
    const st = await h.call("POST", "/api/admin/storages", { name: "OD", type: "onedrive", config: { clientId: "cid", clientSecret: SECRET } }, auth);
    expect(st.status).toBe(201);
    return { h, auth, id: st.json.id as number, tokenCalls };
  }

  it("start 轉往授權頁；callback 驗證 state 並把 refresh token 加密寫回", async () => {
    const { h, auth, id, tokenCalls } = await setup();
    expect((await h.call("GET", `/api/admin/storages/oauth/onedrive/start?storageId=${id}`)).status).toBe(401);
    const s = await h.call("GET", `/api/admin/storages/oauth/onedrive/start?storageId=${id}`, undefined, auth);
    expect(s.status).toBe(302);
    const loc = new URL(s.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://drop.example.com/api/admin/storages/oauth/onedrive/callback");
    expect(loc.searchParams.get("scope")).toContain("offline_access");
    expect(loc.href).not.toContain(SECRET);
    const state = loc.searchParams.get("state")!;

    const bad = await h.call("GET", `/api/admin/storages/oauth/onedrive/callback?code=C&state=${id}.123.abc`);
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("無效");

    const ok = await h.call("GET", `/api/admin/storages/oauth/onedrive/callback?code=CODE1&state=${encodeURIComponent(state)}`);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("授權成功");
    expect(ok.text).not.toContain("NEW_REFRESH_TOKEN");
    expect(tokenCalls[0]).toContain("grant_type=authorization_code");
    expect(tokenCalls[0]).toContain("code=CODE1");

    const raw = await h.ctx.db.first<{ secrets: string }>("SELECT secrets FROM storages WHERE id = ?", [id]);
    expect(raw!.secrets).not.toContain("NEW_REFRESH_TOKEN");
    const row = await h.ctx.storage.row(id);
    const secrets = await h.ctx.box.open(row.secrets);
    expect(secrets).toMatchObject({ refreshToken: "NEW_REFRESH_TOKEN", clientSecret: SECRET });
    // DTO 不外洩
    const dto = await h.call("GET", `/api/admin/storages/${id}`, undefined, auth);
    expect(dto.text).not.toContain("NEW_REFRESH_TOKEN");
    // 類型清單標示支援 OAuth
    const types = await h.call("GET", "/api/admin/storage-types", undefined, auth);
    expect(types.json.find((t: any) => t.type === "gdrive").oauth).toBe(true);
  });

  it("state 綁定類型：拿 onedrive 的 state 打 gdrive callback 會失敗；供應商 error 顯示訊息", async () => {
    const { h, auth, id } = await setup();
    const s = await h.call("GET", `/api/admin/storages/oauth/onedrive/start?storageId=${id}&format=json`, undefined, auth);
    const state = new URL(s.json.url).searchParams.get("state")!;
    expect((await h.call("GET", `/api/admin/storages/oauth/gdrive/callback?code=C&state=${encodeURIComponent(state)}`)).status).toBe(400);
    const e = await h.call("GET", `/api/admin/storages/oauth/onedrive/callback?error=access_denied&error_description=${encodeURIComponent("<b>拒絕</b>")}`);
    expect(e.status).toBe(400);
    expect(e.text).not.toContain("<b>拒絕");
    expect((await h.call("GET", `/api/admin/storages/oauth/s3/start?storageId=${id}`, undefined, auth)).status).toBe(400);
  });
});
