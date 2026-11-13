# HarborDrop

自架的「上傳即分享」檔案服務。後端以 [Hono](https://hono.dev) 撰寫，同一份程式可部署到 **Cloudflare Workers（D1）** 或 **Node／Docker（SQLite）**；前端為 Vue 3。

大檔案一律由**瀏覽器直傳**到儲存供應商，位元組不經過後端，因此不受 Workers 請求體上限影響：

- **HuggingFace**：Xet 協定（瀏覽器內以 wasm 切塊，xorb 直接上傳到 `cas-server.xethub.hf.co`），HF token 只存在伺服器，瀏覽器只拿到短效 xet 寫入權杖。
- **S3 相容儲存**（AWS S3、R2、B2、MinIO…）：multipart 上傳，後端預簽章各分片 URL，預設 16MB 分片、同時 4 片。

兩者都以「分片（xorb／part）」為單位獨立重試（指數退避），並支援續傳。

> 這是 cloudharbor 的重寫版（全新程式碼）。目前完成核心：管理員登入、儲存設定、上傳與分享、HF Xet 與 S3 直傳。
> 其他渠道與功能（掛載瀏覽、文字分享、WebDAV、API 金鑰…）的介面、路由與資料表已預留，見 [docs/ARCHITECTURE-zhTW.md](docs/ARCHITECTURE-zhTW.md)。

## 功能（目前版本）

- 管理員登入（首次啟動依環境變數建立帳號，密碼以 PBKDF2 雜湊；session token 只存雜湊）
- 儲存設定 CRUD：HuggingFace dataset／model 倉庫、S3 相容儲存；機密欄位以 AES-GCM 加密，**永不回傳瀏覽器**
- 上傳並分享：自訂或隨機連結、密碼、有效期限、最多瀏覽次數；可開放匿名上傳（全域開關＋逐一儲存允許＋大小上限）
- 分享頁 `/f/:slug`：圖片／影片／音訊／文字／PDF 預覽與下載
  - HF：公開倉庫轉址到 resolve URL；私有倉庫由後端帶 token 代理串流（支援 Range）
  - S3：預簽章 GET 轉址

## 環境變數

| 變數 | 必填 | 說明 |
|---|---|---|
| `APP_SECRET` | ✅ | 至少 16 字元。用來加密儲存機密欄位與簽發分享權杖；**變更後既有儲存的機密將無法解密** |
| `ADMIN_USERNAME` | 首次 | 管理員帳號（資料庫沒有管理員時建立） |
| `ADMIN_PASSWORD` | 首次 | 管理員密碼 |
| `ADMIN_RESET` |  | 設為 `1` 時，啟動時以 `ADMIN_PASSWORD` 重設該帳號密碼（用完請移除） |
| `SESSION_TTL_HOURS` |  | 登入有效時數，預設 168 |
| `PUBLIC_URL` |  | 對外網址（反向代理後方時用於產生分享連結），例如 `https://drop.example.com` |
| `PORT` / `HOST` / `DATA_DIR` / `STATIC_DIR` |  | 僅 Node：埠（8787）、位址、資料目錄（`./data`）、前端目錄 |

## 部署到 Cloudflare Workers

```bash
npm ci
npx wrangler d1 create harbordrop          # 把回傳的 database_id 填入 wrangler.toml
npx wrangler secret put APP_SECRET
npx wrangler secret put ADMIN_PASSWORD     # ADMIN_USERNAME 在 wrangler.toml [vars]，預設 admin
npm run deploy:workers                     # = 建置前端 + wrangler deploy
```

- 資料表在第一次請求時自動建立；也可手動 `npx wrangler d1 migrations apply harbordrop --remote`。
- `wrangler.toml` 已設定 assets（SPA 後備）與每分鐘 Cron（清理過期上傳工作階段）。
- 本機測試：建立 `.dev.vars`（`APP_SECRET=…`、`ADMIN_PASSWORD=…`）後執行 `npx wrangler dev`。

## 部署到 Docker

```bash
cat > .env <<'EOF'
APP_SECRET=請換成至少16字元的隨機字串
ADMIN_USERNAME=admin
ADMIN_PASSWORD=請換成強密碼
EOF
docker compose up -d --build
# 開啟 http://localhost:8787 ，資料庫位於 ./data/harbordrop.db
```

不使用 Docker 也可以直接以 Node 22 執行：

```bash
npm ci && npm run build
APP_SECRET=… ADMIN_PASSWORD=… npm start
```

## 儲存設定說明

### HuggingFace
- 權杖需要該倉庫的 **write** 權限（fine-grained token 勾選該 repo 的 write 即可）。
- 「路徑前綴」下的 `/{yyyy}/{mm}/{dd}/{隨機}/{檔名}` 存放上傳檔案（範本可在系統設定修改）。
- 下載方式「自動」：公開倉庫轉址、私有倉庫經後端代理（Workers 上代理串流不受請求體上限影響，但會計入 Worker 流量）。

### S3 相容儲存
- 需在 bucket 設定 **CORS**，允許你的網站來源 `PUT`、`GET`，並 `ExposeHeaders: ["ETag"]`，例如：
  ```json
  [{ "AllowedOrigins": ["https://drop.example.com"], "AllowedMethods": ["GET", "PUT"], "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
  ```
- MinIO 等自架服務通常要勾選「路徑式 URL」。
- 建議在 bucket 設定生命週期規則：自動中止 7 天以上未完成的 multipart upload。

## 開發

```bash
npm ci
npm run dev:backend      # http://127.0.0.1:8787（需設定 APP_SECRET 等環境變數）
npm run dev:frontend     # Vite，/api 代理到 8787
npm test                 # vitest：資料庫、加密、ACL、上傳／分享流程、HF 代理安全、S3 分片重試／續傳
```

端到端測試腳本（需真實憑證，不在 `npm test` 內）：
- `packages/backend/test/e2e/hf-real.ts`：HF Xet 真實上傳／驗證／分享下載／刪除（`FAULT=1` 模擬 xorb 中斷）
- `packages/backend/test/e2e/s3-local.ts`：本機 S3 相容伺服器（moto／MinIO）multipart、續傳、分片故障
- `packages/backend/test/e2e/browser-hf.mjs`：Playwright Chromium 操作實際前端上傳

架構與新增渠道／功能的方法：[docs/ARCHITECTURE-zhTW.md](docs/ARCHITECTURE-zhTW.md)、[docs/MODULES-zhTW.md](docs/MODULES-zhTW.md)。

## 已知限制

- HF Xet：@huggingface/hub 目前逐一（非並行）上傳 xorb；上傳前會先完整讀一次檔案計算 sha256（LFS 需要）。續傳時已上傳的 xorb 會略過，但仍需重新切塊。
- 分享瀏覽次數：每次「非續傳」的內容請求（無 Range 或 Range 自 0 起）計一次，預覽也算一次。
- 登入尚無頻率限制（建議在 Cloudflare／反向代理設定 rate limit）。
