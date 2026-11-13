# HarborDrop 架構說明（給開發者）

本文件定義模組邊界、儲存驅動介面、資料表與路由規範。**所有功能模組依此平行開發，不需改動核心。**

## 1. 專案結構

```
harbordrop/
├─ packages/
│  ├─ shared/                 前後端共用（純 TS，無平台依賴）
│  │  └─ src/
│  │     ├─ api-types.ts      API DTO 型別
│  │     ├─ preview.ts        預覽種類判斷 previewKind()
│  │     └─ upload/           瀏覽器直傳客戶端（瀏覽器與 Node 測試共用同一份）
│  │        ├─ api.ts         HdClient：呼叫後端 API
│  │        ├─ common.ts      retryingFetch、ResumeStore、統計、故障注入
│  │        ├─ retry.ts       指數退避
│  │        ├─ xet.ts         HuggingFace Xet（@huggingface/hub commitIter + 後端 hub 代理）
│  │        ├─ s3.ts          S3 multipart（預簽章分片）
│  │        └─ index.ts       PROTOCOLS 協定表、uploadFile() 完整流程
│  ├─ backend/
│  │  └─ src/
│  │     ├─ app.ts            createApp()：與平台無關的 Hono 應用、錯誤處理、身分解析、runCron()
│  │     ├─ runtime/worker.ts Cloudflare Workers 進入點（D1 + assets + Cron）
│  │     ├─ runtime/node.ts   Node/Docker 進入點（better-sqlite3 + 靜態檔 + setInterval 排程）
│  │     ├─ db/               Db 介面（adapter.ts）、d1.ts、sqlite.ts、migrate.ts、migrations/*.sql
│  │     ├─ core/             context（AppContext）、auth（Principal、can()）、crypto、sign、settings、errors
│  │     ├─ storage/          types.ts（驅動介面）、registry.ts、service.ts、util.ts、drivers/<type>/
│  │     └─ modules/          功能模組，每個資料夾一個 HdModule
│  └─ frontend/               Vue 3 + Vite（zh-TW）
│     └─ src/ pages/ previews/ i18n/ api/ router.ts
├─ wrangler.toml  Dockerfile  docker-compose.yml  vitest.config.ts
```

## 2. 執行平台

| | Cloudflare Workers | Node / Docker |
|---|---|---|
| 進入點 | `runtime/worker.ts` | `runtime/node.ts`（建置為 `dist/server.mjs`） |
| 資料庫 | D1 → `createD1Db` | SQLite → `createSqliteDb`（better-sqlite3, WAL） |
| 靜態前端 | assets 綁定（SPA 後備；`/api/*`、`/dav*` 先進 Worker） | `serveStatic` + SPA 後備 |
| 排程 | Cron Trigger 每分鐘 → `runCron` | `setInterval` 每分鐘 → `runCron` |
| 遷移 | 啟動時自動（亦可 `wrangler d1 migrations apply`） | 啟動時自動 |

**規則**：後端程式只能用 WebCrypto / fetch / Web Streams 等標準 API；`node:*` 只允許出現在 `runtime/node.ts` 與標註 `platforms: ["node"]` 的驅動（例如 local）。

## 3. 資料庫

- 介面：`Db { all, first, run, batch, exec }`，佔位符一律 `?`，參數會正規化（undefined→NULL、boolean→0/1）。
- 時間一律 Unix 毫秒；JSON 存 TEXT；布林 0/1。
- 新增資料表或欄位：新增 `packages/backend/src/db/migrations/000N_<name>.sql`，再執行 `npm run gen:migrations -w @harbordrop/backend`（測試會檢查內嵌檔是否同步）。**不要修改已發佈的遷移檔。**

### 資料表（`0001_init.sql`，已涵蓋全部功能）

| 表 | 用途 | 負責模組 |
|---|---|---|
| `admins`、`sessions` | 管理員與登入 session（token 只存 SHA-256） | auth（已完成） |
| `api_keys`、`api_key_acl` | API 金鑰、全域權限、依儲存／掛載／路徑前綴的 ACL | apikeys（預留） |
| `settings` | 系統設定（JSON 值） | settings（已完成） |
| `storages` | 儲存設定；`config` 明文、`secrets` AES-GCM 加密 | storages（已完成） |
| `mounts` | 虛擬路徑掛載 | fs（預留） |
| `upload_sessions` | 瀏覽器直傳工作階段狀態機 | uploads（已完成） |
| `shares` | 檔案分享 | shares（已完成） |
| `pastes` | 文字分享 | pastes（預留） |
| `fs_meta` | 目錄 readme／header／密碼／隱藏規則 | fsmeta（預留） |
| `search_index` | 檔名搜尋索引 | search（預留） |
| `scheduled_jobs` | 排程工作定義與上次執行結果 | jobs（預留） |
| `tasks` | 背景工作清單（複製、搬移、索引、備份…） | tasks（預留） |

## 4. 身分與權限

`resolvePrincipal()` 依序：管理員 session（Bearer 或 HttpOnly cookie `hd_session`）→ 各模組的 `authenticate()`（API 金鑰由 apikeys 模組提供）→ 匿名。

```ts
type Principal =
  | { kind: "admin"; id; username }
  | { kind: "apikey"; id; name; permissions: string[]; acl: AclRule[] }
  | { kind: "anon" };
can(principal, "fs.read", { storageId?, mountId?, path? })  // 共用 ACL 判斷
requireAdmin(c)
```

權限名稱慣例：`upload`、`share`、`paste`、`fs.read`、`fs.write`、`fs.delete`、`webdav`。ACL 的 `perms` 用動作尾字（`read`/`write`/`delete`/`*`）。

## 5. 儲存驅動介面（`storage/types.ts`）

```ts
interface StorageDriver {
  type; capabilities: { list, write, delete, mkdir, rename, copy, uploadProtocols: string[], maxProxyUploadBytes? };
  testConnection(): Promise<{ ok; message }>;
  stat(path): Promise<FileEntry | null>;
  list?(path, { cursor?, limit? }): Promise<{ entries: FileEntry[]; cursor? }>;
  download(path, { filename?, inline?, mime?, request? }): Promise<{ kind: "redirect", url } | { kind: "response", response }>;
  put?(path, body, { size, mime? }): Promise<FileEntry>;          // 經後端（小檔、無法直傳的渠道）
  delete?(paths); mkdir?(path); rename?(from, to); copy?(from, to);
  // 瀏覽器直傳
  initUpload?({ path, filename, size, mime? }): Promise<{ protocol, client, providerUploadId?, partSize?, meta? }>;
  uploadAction?(session, action, { subpath, request, origin, actionBase }): Promise<{ response, meta?, state? }>;
  completeUpload?(session, body): Promise<{ entry }>;
  abortUpload?(session): Promise<void>;
}
interface DriverDefinition { type; label; description?; fields: ConfigField[]; platforms?; readonly?; create(config, ctx) }
```

- 路徑一律「儲存內相對路徑」，以 `/` 開頭；驅動自行套用前綴。
- `fields` 中 `type: "secret"` 的欄位自動加密存放、永不回傳；前端依 `fields` 自動產生表單。
- 錯誤請拋 `HttpError`（`core/errors.ts`），訊息用正體中文。
- **位元組原則**：能直傳就直傳（瀏覽器 ↔ 供應商），後端只負責簽章、權杖與提交；Workers 請求體上限只影響 `put`。

### 新增一個渠道（例：OneDrive）

1. 建立 `packages/backend/src/storage/drivers/onedrive/index.ts`，匯出 `onedriveDriver: DriverDefinition`。
2. 在 `storage/registry.ts` 的 `DRIVERS` 加入一行。
3. 若需要新的直傳協定（例如 `graph-upload-session`）：
   - 後端：在驅動的 `initUpload`／`uploadAction`／`completeUpload` 實作（`uploadAction` 透過 `/api/uploads/:id/action/<name>/*` 被呼叫）。
   - 前端：在 `packages/shared/src/upload/` 新增 `<protocol>.ts`，於 `index.ts` 的 `PROTOCOLS` 註冊；每個分片請用 `retryingFetch()`（自動指數退避、統計、故障注入、取消）。
4. 在 `packages/backend/test/` 加單元測試（mock `ctx.fetch`），可參考 `huggingface.test.ts`。

預定渠道與建議協定：

| 渠道 | 上傳 | 下載 | 備註 |
|---|---|---|---|
| s3 ✅ | `s3-multipart` 預簽章分片 | 預簽章 GET | 需 bucket CORS（PUT/GET、ExposeHeaders: ETag） |
| huggingface ✅ | `xet`（cas-server 直傳） | resolve 轉址／私有倉庫代理 | |
| onedrive | Graph upload session（分片 PUT 直傳） | `@microsoft.graph.downloadUrl` 轉址 | OAuth refresh token 存 secrets |
| gdrive | resumable upload session（瀏覽器直傳） | 代理串流（需 token） | |
| webdav | `put`（經後端）或 chunk-relay | 代理串流 | Workers 上限 100MB |
| local | `put`（串流寫入 dataDir） | 串流 | `platforms: ["node"]` |
| github | `put`（Contents API／Git Data API） | raw 轉址或代理 | 單檔大小受 GitHub 限制 |
| telegram / discord | `chunk-relay`（瀏覽器分片 → 後端轉送，每片 ≤ 平台上限） | 後端合併串流 | 需在 `meta` 記錄分片清單 |
| mirror | 不支援 | 轉址到鏡像來源 | `readonly: true` |

## 6. 功能模組（`modules/<name>/index.ts`）

```ts
interface HdModule {
  name: string;
  routes?(app: Hono<AppEnv>): void;
  settings?: SettingDef[];                 // 新增系統設定（public: true 會出現在 /api/public/config）
  authenticate?(c): Promise<Principal | null>;
  cron?(ctx: AppContext): Promise<void>;   // 每分鐘喚醒；自行判斷是否到期
  jobs?: Record<kind, (ctx, config) => Promise<string | void>>;  // 供 jobs 模組排程
}
```

- 在路由內以 `c.get("ctx")` 取得 `AppContext { db, env, platform, box, settings, storage, modules }`，`c.get("principal")` 取得身分。
- 模組之間**只能 import 對方的 `service.ts`**（例：`modules/shares/service.ts` 的 `createShare()`），不得 import 對方的 `index.ts` 內部函式。
- 預留模組目前由 `plannedModule()` 對其路由前綴回應 501；實作時直接替換該資料夾的 `index.ts`（匯出名稱不變），`modules/index.ts` 不必改。

### 路由前綴（已保留）

| 前綴 | 模組 | 狀態 |
|---|---|---|
| `/api/auth/*` | auth | ✅ |
| `/api/public/config`、`/api/admin/settings` | settings | ✅ |
| `/api/admin/storage-types`、`/api/admin/storages*` | storages | ✅ |
| `/api/uploads*` | uploads | ✅ |
| `/api/shares/:slug*`、`/api/admin/shares*` | shares | ✅ |
| `/api/admin/api-keys*` | apikeys | 預留 |
| `/api/fs/*`、`/api/admin/mounts*` | fs | 預留 |
| `/api/admin/fs-meta*` | fsmeta | 預留 |
| `/api/pastes*`、`/api/admin/pastes*` | pastes | 預留 |
| `/dav`、`/dav/*` | webdav | 預留 |
| `/api/search`、`/api/admin/search*` | search | 預留 |
| `/api/admin/backup*` | backup | 預留 |
| `/api/admin/jobs*` | jobs | 預留 |
| `/api/admin/tasks*` | tasks | 預留 |
| `/api/health` | 核心 | ✅ |

前端路由：`/`（上傳）、`/login`、`/f/:slug`（分享頁）、`/admin/*`；預留 `/fs/*`、`/p/:slug`、`/admin/mounts|api-keys|fs-meta|backup|jobs|tasks`。

### 新增一個功能（例：pastes）

1. 改寫 `backend/src/modules/pastes/index.ts`，匯出 `pastesModule: HdModule`（路由前綴照上表）。
2. 資料表已存在；需要新欄位時新增遷移檔。
3. 前端：新增 `frontend/src/pages/PastePage.vue`，在 `router.ts` 加路由；管理頁在 `pages/admin/AdminLayout.vue` 的 `tabs` 加一項；字串加到 `i18n/zh-TW.ts`。
4. 測試：`packages/backend/test/<name>.test.ts`，使用 `test/helpers/app.ts` 的 `makeApp()`（記憶體 SQLite + 測試驅動）。

## 7. 預覽

`shared/src/preview.ts` 的 `previewKind()` 回傳 `image | video | audio | text | markdown | pdf | office | epub | none`；前端 `previews/index.ts` 註冊表將 kind 對應到元件（props：`src`、`info`）。目前已實作 image / video / audio / text / pdf；markdown、office、epub 預留。

## 8. 安全要點

- 供應商憑證（HF token、S3 金鑰…）只存在 `storages.secrets`（AES-256-GCM，金鑰來自 `APP_SECRET`），API 只回傳 `secretsSet`（欄位名稱）。
- HuggingFace LFS batch 回應的 `verify` 動作標頭內含 **HF token 明文**；hub 代理會移除 `verify` 與所有 `Authorization` 標頭（有單元測試守護）。
- 上傳工作階段以隨機 `uploadToken`（只存 SHA-256）授權，匿名上傳者也能續傳但無法操作他人工作階段。
- 分享密碼以 PBKDF2 雜湊；解鎖後發 HMAC 短效權杖（6 小時），密碼變更即失效。
