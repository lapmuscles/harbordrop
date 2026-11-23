# HarborDrop

自架的「上傳即分享」檔案服務與多儲存檔案管理。後端以 [Hono](https://hono.dev) 撰寫，同一份程式可部署到 **Cloudflare Workers（D1）** 或 **Node／Docker（SQLite）**；前端為 Vue 3，可安裝成 PWA。

能直傳的渠道一律由**瀏覽器直傳**到儲存供應商（位元組不經過後端），因此不受 Workers 請求體上限影響；不能直傳的渠道（Telegram、Discord、WebDAV、GitHub…）則由後端代理或分片中繼。

## 功能

**上傳與分享**
- 上傳並分享：自訂或隨機連結、密碼、有效期限、最多瀏覽次數；分片獨立重試（指數退避）與續傳。
- **文件夾上傳**：上傳頁可選整個資料夾（或拖入資料夾），相對路徑保留在儲存路徑裡，同批檔案落在同一目錄；每檔各自建立分享（沿用既有分享機制），逐檔進度、整體進度，單檔失敗不中斷其餘檔案、可單獨重試。檔案總管也可上傳整個資料夾到掛載目錄。
  - 分享流程的文件夾上傳需要瀏覽器直傳渠道（HuggingFace、S3、Google Drive、OneDrive、Telegram、Discord）；WebDAV、本機、GitHub 是經後端代理的渠道，本來就不能用於分享上傳（單檔亦同），文件夾上傳請改用檔案總管。唯讀鏡像不支援上傳。
  - 空資料夾沒有檔案，不會出現在上傳清單（瀏覽器 API 的限制）；OneDrive 上傳前會先逐層建好父資料夾。
- 分享頁 `/f/:slug`：圖片／影片／音訊／文字／程式碼／Markdown／PDF／Office（docx、xlsx）／EPUB 預覽與下載。
- 文字分享（paste）`/p/:slug`：Markdown／純文字／程式碼高亮，密碼、到期、瀏覽次數上限，原始文字下載。
- 匿名使用：可分別開放匿名上傳（全域開關＋逐一儲存允許＋單檔大小上限）與匿名文字分享；兩者都有**每 IP 每小時次數上限**（可設定，0 = 不限），超過回 429。

**檔案系統**
- 掛載：把任一儲存的某個目錄掛到虛擬路徑，瀏覽、下載、上傳、建立資料夾、重新命名、刪除、複製／搬移、從檔案建立分享。
- 目錄 meta：README／標頭 Markdown、目錄密碼、隱藏規則；可開放匿名瀏覽（`fsPublicBrowse`）。
- 搜尋索引與 WebDAV 伺服器（`/dav`）：路由與資料表已預留，在本分支的基底（integrate）尚未實作，由其他分支提供。

**管理**
- 管理員登入（PBKDF2 雜湊、session 只存雜湊）、TOTP 兩步驟驗證、登入失敗鎖定。
- 管理總覽 `/admin`：分享數、文字分享數、儲存數、掛載數、總上傳量、執行中任務、最近 7 天每日上傳長條圖、最近 10 筆分享。
- 儲存設定 CRUD（機密欄位以 AES-GCM 加密、**永不回傳瀏覽器**）、分享管理、文字分享管理。
- 站台設定：站名、公告（Markdown，顯示在每頁頂端）、預設語言、自訂頁尾（Markdown）、匿名上傳／文字分享開關與上限、匿名瀏覽。
- API 金鑰（權限＋儲存／路徑 ACL）、備份匯出／匯入、排程工作、背景工作清單。

**PWA**
- 可「安裝到主畫面」；靜態檔預先快取、新版自動更新（`autoUpdate`）。
- Service Worker **不會**快取或攔截後端路徑：`/api/*`、`/dav/*`、`/f/<slug>/raw`、`/p/<slug>/raw` 一律走網路。

公開 API：`GET /api/site` 只回非敏感的站台資訊（站名、公告、頁尾、語言、匿名功能開關與上限）；`GET /api/admin/stats?tzOffset=<分鐘>` 需要管理員。

## 環境變數

| 變數 | 必填 | 說明 |
|---|---|---|
| `APP_SECRET` | ✅ | 至少 16 字元。加密儲存機密欄位、簽發分享權杖；**變更後既有儲存的機密將無法解密** |
| `ADMIN_USERNAME` | 首次 | 管理員帳號（資料庫沒有管理員時建立），預設 `admin` |
| `ADMIN_PASSWORD` | 首次 | 管理員密碼 |
| `ADMIN_RESET` |  | 設為 `1` 時，啟動時以 `ADMIN_PASSWORD` 重設該帳號密碼（**用完請移除**） |
| `SESSION_TTL_HOURS` |  | 登入有效時數，預設 168 |
| `PUBLIC_URL` |  | 對外網址，例如 `https://drop.example.com`。反向代理後方時用來產生分享連結與 **OAuth redirect URI** |
| `TRUST_PROXY` |  | 僅 Node。設為 `1`／`true` 才信任 `X-Real-IP`／`X-Forwarded-For`（放在 Nginx、Caddy、Cloudflare Tunnel 等反向代理後方時設定）。未設定時只用 TCP 連線位址，避免用戶端偽造標頭繞過登入鎖定與匿名速率限制。Workers 一律使用 `CF-Connecting-IP`，不需設定 |
| `PORT` / `HOST` / `DATA_DIR` / `STATIC_DIR` |  | 僅 Node：埠（8787）、位址、資料目錄（`./data`）、前端目錄 |
| `TRUST_PROXY` |  | 僅 Node：在反向代理（Nginx、Caddy、Cloudflare Tunnel 等）後方時設為 `true`，才會以 `X-Forwarded-For` 等標頭判斷用戶端 IP（登入限流用）；預設 `false`，只看連線位址，避免偽造 |

站名、公告、匿名上限等「站台設定」存在資料庫，請在 `/admin/settings` 修改，不是環境變數。

## 部署到 Cloudflare Workers

```bash
npm ci
npx wrangler d1 create harbordrop          # 把回傳的 database_id 填入 wrangler.toml
npx wrangler secret put APP_SECRET
npx wrangler secret put ADMIN_PASSWORD     # ADMIN_USERNAME 在 wrangler.toml [vars]，預設 admin
# 選用：npx wrangler secret put PUBLIC_URL（用自訂網域時建議設定）
npm run deploy:workers                     # = 建置前端（含 PWA）+ wrangler deploy
```

- 資料表在第一次請求時自動建立／遷移，**不需要**另外執行 `wrangler d1 migrations apply`。若已經用 wrangler 套用過，程式會讀取 `d1_migrations` 的紀錄、不再重跑；每支遷移也都可安全重跑（已存在的欄位會略過）。反過來，程式自動遷移後再執行 wrangler apply，wrangler 會因欄位已存在而報錯，請勿再手動套用。
- `wrangler.toml` 已設定 assets（SPA 後備，`/api/*`、`/dav` 先交給 Worker）與每分鐘 Cron（清理過期上傳、執行排程工作、清除過期速率紀錄）。
- 本機測試：建立 `.dev.vars`（`APP_SECRET=…`、`ADMIN_PASSWORD=…`）後執行 `npx wrangler dev`。
- **Workers 限制**：單一請求體上限 100 MB（免費／Pro 方案）、記憶體 128 MB。凡是「經後端代理」的上傳都受此限制；本機目錄（local）儲存無法使用。

## 部署到 Docker

```bash
cat > .env <<'EOF'
APP_SECRET=請換成至少16字元的隨機字串
ADMIN_USERNAME=admin
ADMIN_PASSWORD=請換成強密碼
# PUBLIC_URL=https://drop.example.com
# TRUST_PROXY=1     # 放在反向代理後方時
EOF
docker compose up -d --build
# 開啟 http://localhost:8787 ，資料庫位於 ./data/harbordrop.db
```

不使用 Docker 也可以直接以 Node 22 執行：

```bash
npm ci && npm run build
APP_SECRET=… ADMIN_PASSWORD=… npm start
```

放在反向代理後方時，請轉發 `Host`／`X-Forwarded-Proto`／`X-Forwarded-For`，設定 `PUBLIC_URL` 與 `TRUST_PROXY=1`，並把上傳大小上限（例如 Nginx `client_max_body_size`）調到不小於分片大小。

## 儲存渠道：需要的設定與限制

| 渠道 | 上傳方式 | 需要的設定 | 限制與注意事項 |
|---|---|---|---|
| **HuggingFace** | 瀏覽器直傳（Xet） | 倉庫（`user/repo`，dataset／model）、分支、路徑前綴、HF Token（需該倉庫 **write** 權限） | 公開倉庫下載轉址；私有倉庫經後端代理（支援 Range，計入 Worker 流量） |
| **S3 相容**（AWS S3、R2、B2、MinIO…） | 瀏覽器直傳（multipart） | Endpoint、區域、Bucket、Access Key ID／Secret、路徑式 URL、分片大小（預設 16 MB）、同時分片數 | bucket 必須設定 **CORS**（見下）；建議設生命週期自動中止未完成的 multipart upload |
| **OneDrive／SharePoint** | 瀏覽器直傳（upload session） | 區域（國際版／世紀互聯）、帳號類型、Client ID／Secret、Drive ID（SharePoint）、根目錄、分片大小（預設 10 MB，自動調為 320 KiB 倍數、上限 60 MB） | 需在 Azure 應用程式註冊 **OAuth redirect URI**（見下）；經後端的簡易上傳上限 4 MiB |
| **Google Drive** | 瀏覽器直傳（resumable） | Client ID／Secret、根資料夾 ID（`root` = 我的雲端硬碟）、分片大小（預設 8 MB） | 需在 Google Cloud Console 註冊 **OAuth redirect URI**（見下）；經後端代理上傳上限 5 MB |
| **Telegram** | 後端分片中繼 | Bot Token（@BotFather）、Chat ID（Bot 須為成員，頻道需設管理員）、分片大小、API 位址 | 每片 **≤ 20 MB**（Bot API `getFile` 只能下載 20 MB 內的檔案）；大檔自動切片 |
| **Discord** | 後端分片中繼 | Webhook URL，或 Bot Token＋頻道 ID；分片大小、API 位址 | 每片預設 **8 MB**（一般伺服器附件上限 10 MB；Nitro／加成伺服器可調高） |
| **GitHub** | 經後端代理 | 擁有者、儲存庫、分支、存取權杖（contents 寫入權限）、根目錄 | 單檔上限：**Workers 25 MB**（128 MB 記憶體＋base64 膨脹約 1.33 倍）、**Node 100 MB**（GitHub 單檔上限）；有 API 速率限制 |
| **WebDAV** | 經後端代理 | 伺服器網址、使用者名稱、密碼、根目錄 | 整檔經後端上傳，上限 95 MB（受 Workers 100 MB 請求上限） |
| **本機目錄（local）** | 經後端代理 | 根目錄（相對於 `DATA_DIR`） | **僅 Node／Docker**；Workers 不支援 |

### S3 CORS 範例

```json
[{ "AllowedOrigins": ["https://drop.example.com"], "AllowedMethods": ["GET", "PUT"], "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
```

MinIO 等自架服務通常要勾選「路徑式 URL」。

### OneDrive／Google Drive 的 OAuth redirect URI

在儲存設定頁按「授權」前，先到供應商後台把下列網址加入允許的 redirect URI（`<網站>` 為你的對外網址，與 `PUBLIC_URL` 一致）：

- OneDrive：`<網站>/api/admin/storages/oauth/onedrive/callback`（Azure Portal → 應用程式註冊 → 驗證 → Web 平台）
- Google Drive：`<網站>/api/admin/storages/oauth/gdrive/callback`（Google Cloud Console → 憑證 → OAuth 用戶端 ID → 已授權的重新導向 URI）

授權完成後 Refresh Token 會加密存入資料庫；也可直接手動填入 Refresh Token。

## 開發

```bash
npm ci
npm run dev:backend      # http://127.0.0.1:8787（需設定 APP_SECRET 等環境變數）
npm run dev:frontend     # Vite，/api、/dav 代理到 8787（開發模式不啟用 Service Worker）
npm test                 # vitest：後端模組與前端純函式
npm run typecheck        # 後端 TypeScript 型別檢查
```

端到端測試腳本（需真實憑證，不在 `npm test` 內）：
- `packages/backend/test/e2e/hf-real.ts`：HF Xet 真實上傳／驗證／分享下載／刪除（`FAULT=1` 模擬 xorb 中斷）
- `packages/backend/test/e2e/s3-local.ts`：本機 S3 相容伺服器（moto／MinIO）multipart、續傳、分片故障
- `packages/backend/test/e2e/browser-hf.mjs`：Playwright Chromium 操作實際前端上傳

架構與新增渠道／功能的方法：[docs/ARCHITECTURE-zhTW.md](docs/ARCHITECTURE-zhTW.md)、[docs/MODULES-zhTW.md](docs/MODULES-zhTW.md)。

## 已知限制

- HF Xet：@huggingface/hub 目前逐一（非並行）上傳 xorb；上傳前會先完整讀一次檔案計算 sha256（LFS 需要）。
- 分享瀏覽次數：每次「非續傳」的內容請求（無 Range 或 Range 自 0 起）計一次，預覽也算一次。
- 管理總覽的「上傳」統計以分享紀錄計算（上傳工作階段會被定期清理）；直接刪除的分享不再計入。
- 匿名速率限制採固定一小時視窗（整點重置），只計入通過開關與大小檢查的請求。
- 介面目前只有繁體中文；「預設語言」設定已預留給之後的語系。
