/**
 * S3 multipart 端到端測試（本機 S3 相容伺服器，例如 moto_server 或 MinIO）。
 *
 *   S3_ENDPOINT=http://127.0.0.1:5055 FILE=/tmp/x.bin npx tsx packages/backend/test/e2e/s3-local.ts
 *
 * 驗證：建立工作階段 → 中途取消（模擬斷線）→ 以同一工作階段續傳（list-parts 略過已完成分片）
 * → 分片故障注入只重試該分片 → 完成 → 分享下載（預簽章轉址）sha256 比對 → 刪除。
 */
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, openAsBlob, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AwsClient } from "aws4fetch";
import { startNode } from "../../src/runtime/node";
import { HdClient, uploadS3Multipart } from "@harbordrop/shared/upload";

const FILE = process.env.FILE!;
const ENDPOINT = process.env.S3_ENDPOINT ?? "http://127.0.0.1:5055";
const PORT = Number(process.env.PORT ?? 18789);
const out = (o: unknown) => console.log(JSON.stringify(o));

async function sha256File(path: string) {
  const h = createHash("sha256");
  for await (const c of createReadStream(path, { highWaterMark: 8 << 20 })) h.update(c);
  return h.digest("hex");
}

async function main() {
  const size = statSync(FILE).size;
  const aws = new AwsClient({ accessKeyId: "test", secretAccessKey: "testsecret", service: "s3", region: "us-east-1" });
  const bucket = `hd-${Date.now()}`;
  out({ step: "create-bucket", status: (await aws.fetch(`${ENDPOINT}/${bucket}`, { method: "PUT" })).status });

  if (!process.env.BASE_URL) Object.assign(process.env, { DATA_DIR: mkdtempSync(join(tmpdir(), "hd-s3-")), PORT: String(PORT), APP_SECRET: "e2e-secret-0123456789abcdef", ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "e2e-password", STATIC_DIR: "/nonexistent" });
  // BASE_URL：改測已在執行的後端（例如 wrangler dev 的 Workers 執行期），帳密取 ADMIN_USERNAME/ADMIN_PASSWORD
  const external = process.env.BASE_URL;
  if (external) Object.assign(process.env, { ADMIN_PASSWORD: process.env.EXT_ADMIN_PASSWORD ?? "" });
  const srv = external ? { close() {} } : await startNode();
  const base = external ?? `http://127.0.0.1:${PORT}`;
  try {
    const { token }: any = await (await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: process.env.ADMIN_PASSWORD }) })).json();
    const api = new HdClient({ baseUrl: base, token });
    const st = await api.json<any>("POST", "/api/admin/storages", {
      name: "本機 S3",
      type: "s3",
      config: { endpoint: ENDPOINT, region: "us-east-1", bucket, accessKeyId: "test", secretAccessKey: "testsecret", forcePathStyle: true, pathPrefix: "/hd", partSizeMB: 16, concurrency: 4 },
    });
    out({ step: "storage", secretsSet: st.secretsSet, configKeys: Object.keys(st.config) });
    out({ step: "test-connection", ...(await api.json<any>("POST", `/api/admin/storages/${st.id}/test`)) });
    const localSha = await sha256File(FILE);
    const blob = await openAsBlob(FILE);

    const session = await api.initUpload({ storageId: st.id, filename: FILE.split("/").pop()!, size, share: { maxViews: 3 } });
    out({ step: "init", protocol: session.protocol, client: session.client });

    // 第一輪：完成 3 個分片後中斷
    const ac = new AbortController();
    let done = 0;
    const r1 = await uploadS3Multipart(api, session, blob, {
      signal: ac.signal,
      resume: { has: () => false, add: () => void (++done >= 3 && ac.abort(new Error("模擬使用者斷線"))) },
    }).catch((e) => ({ error: String(e?.message ?? e) }));
    out({ step: "round1-interrupted", result: "error" in r1 ? r1.error : "unexpectedly finished", partsDoneBeforeAbort: done });

    // 第二輪：同一工作階段續傳＋分片 5 第一次嘗試故障
    const t0 = Date.now();
    const r2 = await uploadS3Multipart(api, session, blob, {
      faultInjector: ({ kind, id, attempt }) => (kind === "part" && id === "5" && attempt === 1 ? 50 : undefined),
      onRetry: (r) => out({ step: "retry", kind: r.kind, id: r.id, attempt: r.attempt, delayMs: r.delayMs, error: r.error }),
    });
    const perPart = new Map<string, number>();
    for (const a of r2.stats.attempts) perPart.set(a.id, (perPart.get(a.id) ?? 0) + 1);
    out({ step: "round2-resumed", ms: Date.now() - t0, skippedParts: r2.stats.skipped, uploadedParts: perPart.size, attempts: r2.stats.attempts.length, retriedParts: [...perPart].filter(([, n]) => n > 1) });

    const res = await api.complete(session, { parts: r2.parts });
    out({ step: "complete", url: res.url, size: res.share.size, parts: r2.parts.length });

    const dl = await fetch(`${base}/api/shares/${res.share.slug}/content`, { redirect: "manual" });
    const loc = dl.headers.get("location")!;
    const body = await fetch(loc);
    const h = createHash("sha256");
    let n = 0;
    for await (const c of body.body as any) {
      h.update(c);
      n += c.length;
    }
    const dsha = h.digest("hex");
    out({ step: "download", status: dl.status, presigned: /X-Amz-Signature=/.test(loc), bytes: n, shaMatch: dsha === localSha });

    await api.json("DELETE", `/api/admin/shares/${res.share.slug}?deleteFile=1`);
    out({ step: "cleanup", headAfterDelete: (await aws.fetch(`${ENDPOINT}/${bucket}/hd${new URL(loc).pathname.split(`/${bucket}/hd`)[1]}`, { method: "HEAD" })).status });
  } finally {
    srv.close();
  }
}
main().catch((e) => {
  console.error("E2E 失敗：", e);
  process.exit(1);
});
