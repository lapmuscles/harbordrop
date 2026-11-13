/**
 * 真實 HuggingFace Xet 端到端測試（不在 vitest 中自動執行）。
 *
 *   HF_TOKEN=… HF_REPO=user/dataset FILE=/path/to/file [FAULT=1] [KEEP=1] npx tsx packages/backend/test/e2e/hf-real.ts
 *
 * 流程：啟動 Node 後端（暫存資料庫）→ 登入 → 建立 HF 儲存（前綴 _harbordrop_test）→
 * 以前端同一份上傳模組（@harbordrop/shared/upload）上傳 → 驗證倉庫中大小與 sha256 →
 * 透過分享連結下載並比對 sha256 → 刪除分享與倉庫檔案（commit 刪除）。
 * FAULT=1：在第 2 個 xorb 第一次嘗試時於 1.5 秒後中斷請求，驗證只重試該 xorb。
 */
import { createHash } from "node:crypto";
import { createReadStream, openAsBlob, statSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { startNode } from "../../src/runtime/node";
import { HdClient, MemoryResumeStore, uploadFile } from "@harbordrop/shared/upload";

const FILE = process.env.FILE!;
const REPO = process.env.HF_REPO ?? "zaibd/wikipedia-pretrain-zh-tw";
const PORT = Number(process.env.PORT ?? 18787);
const out = (o: unknown) => console.log(JSON.stringify(o));

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 8 << 20 })) h.update(chunk);
  return h.digest("hex");
}

async function main() {
  const size = statSync(FILE).size;
  const dataDir = mkdtempSync(join(tmpdir(), "hd-e2e-"));
  Object.assign(process.env, {
    DATA_DIR: dataDir,
    PORT: String(PORT),
    APP_SECRET: "e2e-secret-0123456789abcdef",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "e2e-password",
    STATIC_DIR: "/nonexistent",
  });
  const srv = await startNode();
  const base = `http://127.0.0.1:${PORT}`;
  try {
    const login: any = await (await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "e2e-password" }) })).json();
    const api = new HdClient({ baseUrl: base, token: login.token });
    const st = await api.json<any>("POST", "/api/admin/storages", {
      name: "HF 測試",
      type: "huggingface",
      config: { repoType: "dataset", repo: REPO, revision: "main", pathPrefix: "/_harbordrop_test", token: process.env.HF_TOKEN, downloadMode: process.env.DL_MODE ?? "auto" },
    });
    out({ step: "storage", id: st.id, secretsSet: st.secretsSet, configHasToken: "token" in st.config });
    out({ step: "test-connection", ...(await api.json<any>("POST", `/api/admin/storages/${st.id}/test`)) });

    const t0 = Date.now();
    const localSha = process.env.LOCAL_SHA ?? (await sha256File(FILE));
    out({ step: "local-sha256", sha256: localSha, size, ms: Date.now() - t0 });

    const blob = await openAsBlob(FILE); // 檔案後端的 Blob，不會整檔載入記憶體
    let lastPct = -1;
    const retries: unknown[] = [];
    const resume = new MemoryResumeStore();
    const t1 = Date.now();
    const res = await uploadFile(api, blob, {
      storageId: st.id,
      filename: FILE.split("/").pop()!,
      share: { password: "pw-123", maxViews: 5, expiresInHours: 2 },
      resume,
      onProgress: (p) => {
        const pct = Math.floor(p.fraction * 20) * 5;
        if (pct !== lastPct || p.phase !== "uploading") {
          lastPct = pct;
          out({ step: "progress", phase: p.phase, pct: Math.round(p.fraction * 100), t: Math.round((Date.now() - t1) / 1000) });
        }
      },
      onRetry: (r) => retries.push(r),
      faultInjector: process.env.FAULT === "1" ? ({ kind, index, attempt }) => (kind === "xorb" && index === 1 && attempt === 1 ? 1500 : undefined) : undefined,
    });
    const uploadMs = Date.now() - t1;
    const xorbAttempts = res.stats.attempts.filter((a) => a.kind === "xorb");
    const perXorb = new Map<string, number>();
    for (const a of xorbAttempts) perXorb.set(a.id, (perXorb.get(a.id) ?? 0) + 1);
    out({
      step: "uploaded",
      url: res.url,
      repoSha256: res.share.sha256,
      shaMatch: res.share.sha256 === localSha,
      uploadMs,
      MBps: +(size / 1e6 / (uploadMs / 1000)).toFixed(1),
      xorbs: perXorb.size,
      xorbBytes: xorbAttempts.filter((a) => a.ok).reduce((s, a) => s + a.bytes, 0),
      xorbAttempts: xorbAttempts.length,
      retriedXorbs: [...perXorb.entries()].filter(([, n]) => n > 1).map(([id, n]) => ({ id: id.slice(0, 12), attempts: n })),
      failedAttempts: res.stats.attempts.filter((a) => !a.ok).map((a) => ({ kind: a.kind, index: a.index, attempt: a.attempt, error: a.error, ms: a.ms })),
      shards: res.stats.attempts.filter((a) => a.kind === "shard" && a.ok).length,
      dedupQueries: res.stats.attempts.filter((a) => a.kind === "dedup").length,
      retries,
    });
    writeFileSync(join(dataDir, "stats.json"), JSON.stringify(res.stats));

    // 倉庫內實際檔案（HEAD resolve：X-Linked-Size / X-Linked-ETag）
    const objectPath = (await api.json<any>("GET", "/api/admin/shares")).items[0].objectPath;
    const head = await fetch(`https://huggingface.co/datasets/${REPO}/resolve/main/_harbordrop_test${objectPath.split("/").map(encodeURIComponent).join("/")}`, { method: "HEAD", redirect: "manual" });
    out({ step: "hf-head", status: head.status, linkedSize: head.headers.get("x-linked-size"), linkedEtag: head.headers.get("x-linked-etag"), xetHash: head.headers.get("x-xet-hash"), sizeMatch: Number(head.headers.get("x-linked-size")) === size });

    // 透過分享連結下載：先確認沒密碼會被擋，再解鎖
    const slug = res.share.slug;
    const locked = await fetch(`${base}/api/shares/${slug}/content`, { redirect: "manual" });
    out({ step: "share-locked", status: locked.status });
    const { token }: any = await (await fetch(`${base}/api/shares/${slug}/unlock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "pw-123" }) })).json();
    const t2 = Date.now();
    const dl = await fetch(`${base}/api/shares/${slug}/content?t=${encodeURIComponent(token)}`, { redirect: "manual" });
    let finalStatus = dl.status;
    let body: ReadableStream<Uint8Array> | null = dl.body;
    let redirectedTo: string | null = null;
    if (dl.status === 302) {
      redirectedTo = dl.headers.get("location");
      const r2 = await fetch(redirectedTo!); // 跟隨 HF resolve → CDN
      finalStatus = r2.status;
      body = r2.body;
    }
    const h = createHash("sha256");
    let n = 0;
    for await (const chunk of Readable.fromWeb(body as any)) {
      h.update(chunk);
      n += chunk.length;
    }
    const dlSha = h.digest("hex");
    out({ step: "download", via: redirectedTo ? "redirect" : "proxy", redirectHost: redirectedTo ? new URL(redirectedTo).host : null, status: finalStatus, bytes: n, sha256: dlSha, shaMatch: dlSha === localSha, ms: Date.now() - t2 });
    out({ step: "share-info", ...(await api.json<any>("GET", `/api/shares/${slug}`)) });

    if (process.env.KEEP !== "1") {
      await api.json("DELETE", `/api/admin/shares/${slug}?deleteFile=1`);
      const gone = await fetch(`https://huggingface.co/datasets/${REPO}/resolve/main/_harbordrop_test${objectPath.split("/").map(encodeURIComponent).join("/")}`, { method: "HEAD", redirect: "manual" });
      out({ step: "cleanup", deleted: gone.status === 404, status: gone.status });
    }
  } finally {
    srv.close();
  }
}

main().catch((e) => {
  console.error("E2E 失敗：", e);
  process.exit(1);
});
