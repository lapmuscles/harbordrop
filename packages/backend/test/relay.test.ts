import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createContext } from "../src/core/context";
import { createSqliteDb } from "../src/db/sqlite";
import { parseRange } from "../src/storage/relay";
import { DiscordBackend } from "../src/storage/drivers/discord";
import { HdClient, uploadFile } from "@harbordrop/shared/upload";

const MB = 1024 * 1024;

function bytes(n: number, seed = 1): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 7 + (i >> 8)) & 0xff;
  return b;
}

const urlOf = (u: RequestInfo | URL) => (typeof u === "string" ? u : u instanceof URL ? u.href : u.url);

/** 依 Range 標頭回應（模擬 CDN） */
function serveBytes(data: Uint8Array, init: RequestInit = {}): Response {
  const h = new Headers(init.headers);
  const range = h.get("range");
  if (range) {
    const m = /bytes=(\d+)-(\d+)/.exec(range)!;
    const s = Number(m[1]);
    const e = Math.min(Number(m[2]), data.byteLength - 1);
    return new Response(data.slice(s, e + 1), { status: 206, headers: { "content-range": `bytes ${s}-${e}/${data.byteLength}` } });
  }
  return new Response(data.slice(), { status: 200 });
}

/** 模擬 Telegram Bot API */
function fakeTelegram(opts: { fail429Once?: boolean; noRange?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const messages = new Map<number, string>();
  const calls: string[] = [];
  let msgId = 100;
  let failed = false;
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = urlOf(input);
    const m = /^https:\/\/api\.telegram\.org\/(file\/)?botTOKEN\/(.+)$/.exec(url);
    if (!m) return new Response("unknown", { status: 404 });
    if (m[1]) {
      const id = m[2].replace("documents/", "");
      const data = files.get(id);
      if (!data) return new Response("gone", { status: 404 });
      return opts.noRange ? new Response(data.slice()) : serveBytes(data, init);
    }
    const method = m[2];
    calls.push(method);
    const json = init.body instanceof FormData ? null : init.body ? JSON.parse(String(init.body)) : {};
    switch (method) {
      case "getMe":
        return Response.json({ ok: true, result: { username: "harbor_bot" } });
      case "getChat":
        return Response.json({ ok: true, result: { type: "channel", title: "倉庫" } });
      case "sendDocument": {
        if (opts.fail429Once && !failed) {
          failed = true;
          return Response.json({ ok: false, description: "Too Many Requests", parameters: { retry_after: 1 } }, { status: 429 });
        }
        const fd = init.body as FormData;
        expect(fd.get("chat_id")).toBe("-100123");
        const doc = fd.get("document") as File;
        const data = new Uint8Array(await doc.arrayBuffer());
        expect(data.byteLength).toBeLessThanOrEqual(20 * 1000 * 1000);
        const fileId = `F${files.size + 1}`;
        files.set(fileId, data);
        const id = msgId++;
        messages.set(id, fileId);
        return Response.json({ ok: true, result: { message_id: id, document: { file_id: fileId, file_unique_id: `U${fileId}`, file_size: data.byteLength } } });
      }
      case "getFile":
        return Response.json({ ok: true, result: { file_id: json.file_id, file_path: `documents/${json.file_id}` } });
      case "deleteMessage": {
        const fid = messages.get(json.message_id);
        if (fid) files.delete(fid);
        messages.delete(json.message_id);
        return Response.json({ ok: true, result: true });
      }
    }
    return new Response("?", { status: 404 });
  }) as typeof fetch;
  return { f, files, messages, calls };
}

/** 模擬 Discord Webhook＋CDN（附件網址可設為已過期） */
function fakeDiscord() {
  const atts = new Map<string, { data: Uint8Array; msg: string; filename: string }>();
  const msgs = new Map<string, string>(); // messageId -> attachmentId
  let seq = 1;
  let expired = false;
  let refreshes = 0;
  const W = "https://discord.com/api/webhooks/1/tok";
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = urlOf(input);
    const method = init.method ?? "GET";
    if (url.startsWith("https://cdn.test/")) {
      const u = new URL(url);
      const id = u.pathname.split("/")[2];
      if (expired && u.searchParams.get("v") === "old") return new Response("This content is no longer available.", { status: 404 });
      const a = atts.get(id);
      return a ? serveBytes(a.data, init) : new Response("no", { status: 404 });
    }
    if (url === `${W}?wait=true` && method === "POST") {
      const fd = init.body as FormData;
      const payload = JSON.parse(String(fd.get("payload_json")));
      const file = fd.get("files[0]") as File;
      const data = new Uint8Array(await file.arrayBuffer());
      const mid = String(1000 + seq);
      const aid = String(5000 + seq++);
      atts.set(aid, { data, msg: mid, filename: payload.attachments[0].filename });
      msgs.set(mid, aid);
      return Response.json({ id: mid, channel_id: "77", attachments: [{ id: aid, filename: file.name, size: data.byteLength, url: `https://cdn.test/a/${aid}?v=old` }] });
    }
    const mm = new RegExp(`^${W}/messages/(\\d+)$`).exec(url);
    if (mm) {
      const aid = msgs.get(mm[1]);
      if (!aid) return new Response("Unknown Message", { status: 404 });
      if (method === "DELETE") {
        msgs.delete(mm[1]);
        atts.delete(aid);
        return new Response(null, { status: 204 });
      }
      refreshes++;
      return Response.json({ id: mm[1], channel_id: "77", attachments: [{ id: aid, filename: "x", size: atts.get(aid)!.data.byteLength, url: `https://cdn.test/a/${aid}?v=new` }] });
    }
    if (url === W) return Response.json({ name: "hd-hook" });
    return new Response("?", { status: 404 });
  }) as typeof fetch;
  return {
    f,
    W,
    atts,
    msgs,
    expire() {
      expired = true;
    },
    get refreshes() {
      return refreshes;
    },
  };
}

async function setup(f: typeof fetch, type: string, config: Record<string, unknown>) {
  const db = createSqliteDb(new Database(":memory:"));
  const ctx = await createContext(db, { APP_SECRET: "test-secret-0123456789", ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "pass-1234" }, "node", { fetch: f });
  const app = createApp(async () => ctx);
  const appFetch = ((input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(urlOf(input), init))) as typeof fetch;
  const login: any = await (await appFetch("http://local/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "pass-1234" }) })).json() as any;
  const auth = { authorization: `Bearer ${login.token}` };
  const st: any = await (await appFetch("http://local/api/admin/storages", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: type, type, config }) })).json() as any;
  expect(st.id).toBeTypeOf("number");
  return { ctx, db, appFetch, auth, token: login.token as string, storageId: st.id as number };
}

describe("parseRange", () => {
  it("各種格式", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=95-500", 100)).toEqual({ start: 95, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("items=1-2", 100)).toBe("invalid");
    expect(parseRange(null, 100)).toBeUndefined();
  });
});

describe("Telegram 驅動（chunk-relay）", () => {
  it("瀏覽器分片上傳 → 失敗只重傳該片 → 分享下載（含跨片 Range）→ 列目錄 → 刪除", async () => {
    const tg = fakeTelegram({ fail429Once: true });
    const h = await setup(tg.f, "telegram", { botToken: "TOKEN", chatId: "-100123", chunkSizeMB: 1 });
    const t = await h.appFetch(`http://local/api/admin/storages/${h.storageId}/test`, { method: "POST", headers: h.auth });
    expect(((await t.json()) as any).ok).toBe(true);

    const data = bytes(2 * MB + 12345);
    // 瀏覽器端 fetch：第 1 片第一次斷線（網路錯誤）
    let chunk1 = 0;
    const posts: string[] = [];
    const browserFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes("/chunk?index=")) {
        posts.push(url.split("index=")[1]);
        if (url.endsWith("index=1") && chunk1++ === 0) throw new TypeError("network down");
      }
      return h.appFetch(input, init);
    }) as typeof fetch;
    const api = new HdClient({ baseUrl: "http://local", token: h.token, fetch: browserFetch });
    const res = await uploadFile(api, new Blob([data as BlobPart]), { storageId: h.storageId, filename: "大檔.bin", retry: { baseDelayMs: 1, maxDelayMs: 2 } });
    expect(res.session.protocol).toBe("chunk-relay");
    expect(res.session.client).toMatchObject({ chunkSize: MB, chunkCount: 3 });
    // 第 0 片遇到 Telegram 429（後端回 429 → 瀏覽器重試），第 1 片斷線重試，第 2 片一次成功
    expect(posts.filter((p) => p === "0").length).toBe(2);
    expect(posts.filter((p) => p === "1").length).toBe(2);
    expect(posts.filter((p) => p === "2").length).toBe(1);
    expect(tg.files.size).toBe(3);

    const row = await h.db.first<{ path: string; size: number; chunks: string }>("SELECT * FROM relay_objects");
    expect(row!.size).toBe(data.byteLength);
    expect(JSON.parse(row!.chunks).map((c: any) => c.size)).toEqual([MB, MB, 12345]);
    expect(await h.db.first("SELECT * FROM relay_upload_chunks")).toBeNull();

    const slug = res.share.slug;
    const full = new Uint8Array(await (await h.appFetch(`http://local/api/shares/${slug}/content`)).arrayBuffer());
    expect(full.byteLength).toBe(data.byteLength);
    expect(Buffer.from(full).equals(Buffer.from(data))).toBe(true);

    const s = MB - 10;
    const e = 2 * MB + 5;
    const part = await h.appFetch(`http://local/api/shares/${slug}/content`, { headers: { range: `bytes=${s}-${e}` } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes ${s}-${e}/${data.byteLength}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(Buffer.from(data.slice(s, e + 1)))).toBe(true);

    const driver = await h.ctx.storage.driver(h.storageId);
    const dir = row!.path.slice(0, row!.path.lastIndexOf("/"));
    const top = "/" + row!.path.split("/")[1];
    expect((await driver.list!("/")).entries).toEqual([expect.objectContaining({ name: top.slice(1), isDir: true })]);
    expect((await driver.list!(dir)).entries).toEqual([expect.objectContaining({ name: "大檔.bin", size: data.byteLength, isDir: false })]);
    expect(await driver.stat(dir)).toMatchObject({ isDir: true });

    await driver.delete!([top]);
    expect(await h.db.first("SELECT * FROM relay_objects")).toBeNull();
    expect(tg.files.size).toBe(0);
    expect(tg.messages.size).toBe(0);
  });

  it("續傳：已收到的分片不重傳；缺片時 complete 回 400；分片大小錯誤 400", async () => {
    const tg = fakeTelegram();
    const h = await setup(tg.f, "telegram", { botToken: "TOKEN", chatId: "-100123", chunkSizeMB: 1 });
    const data = bytes(3 * MB, 3);
    const init = await (
      await h.appFetch("http://local/api/uploads", { method: "POST", headers: { ...h.auth, "content-type": "application/json" }, body: JSON.stringify({ storageId: h.storageId, filename: "r.bin", size: data.byteLength }) })
    ).json() as any;
    const up = { "x-upload-token": init.uploadToken };
    const post = (i: number, body: Uint8Array) => h.appFetch(`http://local/api/uploads/${init.sessionId}/chunk?index=${i}`, { method: "POST", headers: up, body: body as BodyInit });
    expect((await post(1, data.slice(MB, 2 * MB))).status).toBe(200);
    expect((await post(0, data.slice(0, 10))).status).toBe(400);
    expect((await post(9, data.slice(0, 10))).status).toBe(400);
    const miss = await h.appFetch(`http://local/api/uploads/${init.sessionId}/complete`, { method: "POST", headers: { ...up, "content-type": "application/json" }, body: "{}" });
    expect(miss.status).toBe(400);
    expect(((await miss.json()) as any).error.code).toBe("chunks_missing");

    const listed = await (await h.appFetch(`http://local/api/uploads/${init.sessionId}/chunk`, { headers: up })).json() as any;
    expect(listed.chunks).toEqual([{ index: 1, size: MB }]);

    // 瀏覽器續傳：只補 0、2
    const posts: string[] = [];
    const browserFetch = (async (input: RequestInfo | URL, i2?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes("/chunk?index=")) posts.push(url.split("index=")[1]);
      return h.appFetch(input, i2);
    }) as typeof fetch;
    const api = new HdClient({ baseUrl: "http://local", fetch: browserFetch });
    const { uploadChunkRelay } = await import("@harbordrop/shared/upload");
    const r = await uploadChunkRelay(api, init, new Blob([data as BlobPart]), { retry: { baseDelayMs: 1 } });
    expect(r.stats.skipped).toBe(1);
    expect(posts.sort()).toEqual(["0", "2"]);
    const done = await h.appFetch(`http://local/api/uploads/${init.sessionId}/complete`, { method: "POST", headers: { ...up, "content-type": "application/json" }, body: "{}" });
    expect(done.status).toBe(200);
    expect(tg.files.size).toBe(3);
  });

  it("中止上傳會刪除已送出的分片；渠道不支援 Range 時仍能正確裁切", async () => {
    const tg = fakeTelegram({ noRange: true });
    const h = await setup(tg.f, "telegram", { botToken: "TOKEN", chatId: "-100123", chunkSizeMB: 1 });
    const driver = await h.ctx.storage.driver(h.storageId);
    const data = bytes(MB + 500, 5);
    await driver.put!("/x/a.bin", data, { size: data.byteLength, mime: "application/octet-stream" });
    const dl = await driver.download("/x/a.bin", { request: new Request("http://x", { headers: { range: "bytes=1048570-1048580" } }) });
    if (dl.kind !== "response") throw new Error("expected response");
    expect(dl.response.status).toBe(206);
    expect(Buffer.from(await dl.response.arrayBuffer()).equals(Buffer.from(data.slice(1048570, 1048581)))).toBe(true);
    const bad = await driver.download("/x/a.bin", { request: new Request("http://x", { headers: { range: "bytes=99999999-" } }) });
    expect(bad.kind === "response" && bad.response.status).toBe(416);

    await driver.rename!("/x", "/y");
    expect(await driver.stat("/y/a.bin")).toMatchObject({ size: data.byteLength });

    const init = await (
      await h.appFetch("http://local/api/uploads", { method: "POST", headers: { ...h.auth, "content-type": "application/json" }, body: JSON.stringify({ storageId: h.storageId, filename: "z.bin", size: 2 * MB }) })
    ).json() as any;
    const up = { "x-upload-token": init.uploadToken };
    await h.appFetch(`http://local/api/uploads/${init.sessionId}/chunk?index=0`, { method: "POST", headers: up, body: bytes(MB) as BodyInit });
    expect(tg.files.size).toBe(3);
    await h.appFetch(`http://local/api/uploads/${init.sessionId}`, { method: "DELETE", headers: up });
    expect(tg.files.size).toBe(2);
    expect(await h.db.first("SELECT * FROM relay_upload_chunks")).toBeNull();
  });
});

describe("Discord 驅動（chunk-relay）", () => {
  it("Webhook 分片上傳、附件網址過期時重新取得、刪除", async () => {
    const dc = fakeDiscord();
    const h = await setup(dc.f, "discord", { webhookUrl: dc.W, chunkSizeMB: 1 });
    const t = await (await h.appFetch(`http://local/api/admin/storages/${h.storageId}/test`, { method: "POST", headers: h.auth })).json() as any;
    expect(t.ok).toBe(true);
    const data = bytes(2 * MB + 7, 9);
    const api = new HdClient({ baseUrl: "http://local", token: h.token, fetch: h.appFetch });
    const res = await uploadFile(api, new Blob([data as BlobPart]), { storageId: h.storageId, filename: "d.bin", retry: { baseDelayMs: 1 } });
    expect(dc.atts.size).toBe(3);

    const a = new Uint8Array(await (await h.appFetch(`http://local/api/shares/${res.share.slug}/content`)).arrayBuffer());
    expect(Buffer.from(a).equals(Buffer.from(data))).toBe(true);
    expect(dc.refreshes).toBe(0);

    dc.expire();
    const r = await h.appFetch(`http://local/api/shares/${res.share.slug}/content`, { headers: { range: `bytes=${2 * MB}-` } });
    expect(r.status).toBe(206);
    expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(data.slice(2 * MB)))).toBe(true);
    expect(dc.refreshes).toBe(1);

    const driver = await h.ctx.storage.driver(h.storageId);
    const row = await h.db.first<{ path: string }>("SELECT path FROM relay_objects");
    await driver.delete!([row!.path]);
    expect(dc.atts.size).toBe(0);
    expect(await h.db.first("SELECT * FROM relay_objects")).toBeNull();
  });

  it("設定驗證：預設 8MB；缺 Webhook 與 Bot 時拒絕；Bot 模式帶 Authorization", async () => {
    expect(new DiscordBackend({ webhookUrl: "https://discord.com/api/webhooks/1/abc" }, fetch).chunkSize).toBe(8 * MB);
    expect(() => new DiscordBackend({}, fetch)).toThrow(/Webhook/);
    expect(() => new DiscordBackend({ webhookUrl: "https://example.com/x" }, fetch)).toThrow(/格式/);
    const seen: { url: string; auth: string | null }[] = [];
    const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      seen.push({ url: urlOf(input), auth: new Headers(init.headers).get("authorization") });
      return Response.json({ id: "1", channel_id: "42", attachments: [{ id: "9", filename: "a", size: 3, url: "https://cdn.test/a/9" }] });
    }) as typeof fetch;
    const b = new DiscordBackend({ botToken: "BT", channelId: "42", chunkSizeMB: 2 }, f);
    expect(b.chunkSize).toBe(2 * MB);
    const ref = await b.uploadChunk("a.part0", new Uint8Array(3));
    expect(ref).toMatchObject({ messageId: "1", attachmentId: "9" });
    expect(seen[0]).toEqual({ url: "https://discord.com/api/v10/channels/42/messages", auth: "Bot BT" });
  });
});
