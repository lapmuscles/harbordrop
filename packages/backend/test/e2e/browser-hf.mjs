/**
 * 真實瀏覽器（Playwright Chromium）HF Xet 上傳測試：操作實際建置的前端頁面。
 *
 *   BASE_URL=http://127.0.0.1:18792 ADMIN_PASSWORD=… HF_TOKEN=… FILE=/tmp/x.bin node browser-hf.mjs
 *   （需先以 node packages/backend/dist/server.mjs 啟動後端；需要 playwright 套件）
 *
 * - 以 page.route 讓「第 2 個 xorb 的第一次 POST」網路中斷，驗證瀏覽器端單一 xorb 重試
 * - 完成後驗證倉庫 sha256／大小、透過分享下載比對 sha256，最後刪除倉庫中的測試檔
 */
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";

const BASE = process.env.BASE_URL;
const FILE = process.env.FILE;
const REPO = process.env.HF_REPO ?? "zaibd/wikipedia-pretrain-zh-tw";
const out = (o) => console.log(JSON.stringify(o));
const sha = async (p) => {
  const h = createHash("sha256");
  for await (const c of createReadStream(p, { highWaterMark: 8 << 20 })) h.update(c);
  return h.digest("hex");
};

const login = await (await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: process.env.ADMIN_PASSWORD }) })).json();
const H = { authorization: `Bearer ${login.token}`, "content-type": "application/json" };
const st = await (await fetch(`${BASE}/api/admin/storages`, { method: "POST", headers: H, body: JSON.stringify({ name: "HF 瀏覽器測試", type: "huggingface", isDefault: true, config: { repo: REPO, repoType: "dataset", pathPrefix: "/_harbordrop_test", token: process.env.HF_TOKEN } }) })).json();
out({ step: "storage", id: st.id });
const size = statSync(FILE).size;
const localSha = await sha(FILE);

const browser = await chromium.launch({ args: ["--no-proxy-server"] });
const page = await browser.newPage();
page.setDefaultTimeout(30_000);
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

let xorbPosts = 0;
const xorbLog = [];
await page.route(/cas-server.*\/v1\/xorbs\//, async (route) => {
  const n = ++xorbPosts;
  const hash = route.request().url().split("/").pop().slice(0, 12);
  if (n === 2) {
    xorbLog.push({ n, hash, action: "abort(網路中斷)" });
    return route.abort("connectionreset");
  }
  xorbLog.push({ n, hash, action: "continue" });
  return relay(route);
});
// 沙箱限制：Chromium 無法直接連外網（請求逾時），ROUTE_VIA_NODE=1 時把對外 https 請求交由
// Playwright（Node 端）代送；頁面內的 JS／wasm（切塊、xorb、重試）仍完全在瀏覽器中執行。
async function relay(route) {
  if (process.env.ROUTE_VIA_NODE !== "1") return route.continue();
  const resp = await route.fetch({ timeout: 300_000 });
  return route.fulfill({ response: resp });
}
if (process.env.ROUTE_VIA_NODE === "1") await page.route((u) => u.protocol === "https:" && !/\/v1\/xorbs\//.test(u.pathname), relay);
let leakedToken = false;
page.on("response", async (r) => {
  try {
    const t = await r.text();
    if (/hf_[A-Za-z0-9]{20,}/.test(t)) leakedToken = true;
  } catch {}
});

out({ step: "browser-launched" });
await page.goto(`${BASE}/login`);
out({ step: "login-page", title: await page.title() });
await page.fill('input[autocomplete="username"]', "admin");
await page.fill('input[type="password"]', process.env.ADMIN_PASSWORD);
await page.click("button");
await page.waitForURL(/\/admin/).catch(async (e) => {
  out({ step: "login-failed", url: page.url(), consoleErrors, html: (await page.content()).slice(0, 800) });
  throw e;
});
out({ step: "logged-in", url: page.url() });
await page.goto(`${BASE}/`);
await page.setInputFiles('input[type="file"]', FILE);
const t0 = Date.now();
await page.click("text=開始上傳");
const resultInput = page.locator("input[readonly]");
const ticker = setInterval(async () => {
  const txt = await page.locator("p.muted, p.error").allTextContents().catch(() => []);
  out({ step: "ui", t: Math.round((Date.now() - t0) / 1000), text: txt.join(" | ").slice(0, 200) });
}, 10_000);
await Promise.race([
  resultInput.waitFor({ timeout: 15 * 60_000 }),
  page.locator("p.error").waitFor({ timeout: 15 * 60_000 }).then(async () => {
    throw new Error("頁面顯示錯誤：" + (await page.locator("p.error").textContent()));
  }),
]).finally(() => clearInterval(ticker));
const url = await resultInput.inputValue();
const ms = Date.now() - t0;
const progressText = await page.locator("p.muted").first().textContent();
out({ step: "browser-uploaded", url, ms, MBps: +(size / 1e6 / (ms / 1000)).toFixed(1), xorbPosts, xorbLog, progressText, consoleErrors: consoleErrors.slice(0, 5), leakedHfTokenToBrowser: leakedToken });
await browser.close();

const slug = url.split("/f/")[1];
const info = await (await fetch(`${BASE}/api/shares/${slug}`)).json();
out({ step: "share", size: info.size, sha256: info.sha256, shaMatch: info.sha256 === localSha, sizeMatch: info.size === size });
const dl = await fetch(`${BASE}/api/shares/${slug}/content`, { redirect: "manual" });
const r2 = await fetch(dl.headers.get("location"));
const h = createHash("sha256");
let n = 0;
for await (const c of r2.body) {
  h.update(c);
  n += c.length;
}
out({ step: "download", via: dl.status, bytes: n, shaMatch: h.digest("hex") === localSha });
const del = await fetch(`${BASE}/api/admin/shares/${slug}?deleteFile=1`, { method: "DELETE", headers: H });
out({ step: "cleanup", status: del.status });
