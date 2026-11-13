# 預留模組規格（平行開發用）

每個模組：改寫 `packages/backend/src/modules/<name>/index.ts`（保留匯出名稱 `<name>Module`），
前端頁面放 `packages/frontend/src/pages/`，測試放 `packages/backend/test/<name>.test.ts`。
共用規則見 [ARCHITECTURE-zhTW.md](./ARCHITECTURE-zhTW.md)。

## apikeys
- 表：`api_keys`、`api_key_acl`。金鑰格式 `hd_<32 hex>`，只存 SHA-256；建立時回傳明文一次。
- 路由：`GET/POST /api/admin/api-keys`、`PATCH/DELETE /api/admin/api-keys/:id`、`PUT /api/admin/api-keys/:id/acl`。
- 實作 `authenticate(c)`：讀 `X-API-Key` 或 `Authorization: Bearer hd_…`，回傳 `{ kind: "apikey", permissions, acl }`，並更新 `last_used_at`。
- 其他模組一律用 `can(principal, perm, scope)` 判斷，不要自行解析金鑰。

## fs（掛載與虛擬目錄）
- 表：`mounts`。虛擬路徑 `/<mount_path>/<rest>` → `storage_id` + `root_path` + `rest`。
- 路由：`GET /api/fs/list?path=`、`GET /api/fs/get?path=`、`GET /api/fs/download?path=`（轉址或串流，沿用驅動 `download`）、
  `POST /api/fs/mkdir|rename|copy|move|delete`、`POST /api/fs/upload/init`（沿用 uploads 模組的工作階段，指定 path）、
  `POST /api/fs/share`（呼叫 `shares/service.ts` 的 `createShare`）；管理：`/api/admin/mounts` CRUD。
- 長時間動作（跨儲存複製／搬移、大量刪除）建立 `tasks` 記錄並交給 tasks 模組。
- 列目錄時套用 fsmeta 的隱藏規則與密碼；匿名存取依設定 `fsPublicBrowse`（自行新增）。

## fsmeta
- 表：`fs_meta`。路由：`/api/admin/fs-meta` CRUD；`GET /api/fs/meta?path=`（由 fs 呼叫或前端直接取）。
- 規則以最接近的祖先路徑生效（`apply_to_children`）；密碼解鎖沿用 `core/sign.ts` 權杖。

## pastes
- 表：`pastes`。路由：`POST /api/pastes`（管理員／API 金鑰 `paste`／設定允許時匿名）、`GET /api/pastes/:slug`、
  `POST /api/pastes/:slug/unlock`、`GET /api/pastes/:slug/raw`；管理：`/api/admin/pastes`。
- 計次／到期／密碼規則與 shares 相同（可參考 `shares/service.ts`）。前端 `/p/:slug`，markdown 預覽共用 previews 的 markdown 元件。

## webdav
- 路由：`/dav/*`（已在 Workers `run_worker_first` 與 Node 皆導向 Hono）。
- 驗證：Basic Auth（管理員帳密或 API 金鑰作密碼）→ 需要 `webdav` 權限。
- 方法：OPTIONS、PROPFIND（Depth 0/1）、GET/HEAD（Range）、PUT、DELETE、MKCOL、MOVE、COPY；底層走 fs 模組的掛載解析。
- Workers 上 PUT 受請求體上限（免費 100MB）限制，需在回應中清楚報錯。

## search
- 表：`search_index`。路由：`GET /api/search?q=&mount=`、`POST /api/admin/search/reindex`（建立 tasks 工作）。
- `jobs: { "search.reindex": … }` 供排程；索引逐掛載 BFS 列目錄，每批寫入用 `db.batch`。

## backup
- 路由：`GET /api/admin/backup/export`（JSON：settings、storages（secrets 仍為密文，附 `APP_SECRET` 相同才可還原的提示）、mounts、shares、pastes、fs_meta、api_keys、scheduled_jobs）、
  `POST /api/admin/backup/import`（模式：merge / replace）。
- `jobs: { "backup.export": … }`：匯出到指定儲存路徑。

## jobs（排程）
- 表：`scheduled_jobs`。路由：`/api/admin/jobs` CRUD、`POST /api/admin/jobs/:id/run`。
- 實作 `cron(ctx)`：找出 `enabled=1 AND next_run_at <= now` 的工作，依 `kind` 從 `ctx.modules[*].jobs` 找處理函式執行，寫回 `last_*`、`next_run_at`。
- 內建 kind 建議：`cleanup.expired`（刪除過期分享／paste，選擇性刪檔）、`search.reindex`、`backup.export`、`mirror.sync`。
- Workers 單次執行時間有限：處理函式需可分段（以 tasks 進度續跑）。

## tasks（背景工作）
- 表：`tasks`。路由：`GET /api/admin/tasks`、`GET /api/admin/tasks/:id`、`POST /api/admin/tasks/:id/cancel`、`DELETE /api/admin/tasks/:id`。
- 提供 `tasks/service.ts`：`createTask(ctx, kind, payload)`、`updateProgress()`、`finish()`；執行由 `cron()` 分段推進（Workers 每分鐘、Node 可另開 worker loop）。

## 前端預留
- 預覽：`previews/` 新增 `MarkdownPreview.vue`（建議 markdown-it + DOMPurify）、`OfficePreview.vue`（docx: docx-preview；xlsx: SheetJS；pptx 可用 Microsoft Office Online Viewer 的公開 URL 選項）、`EpubPreview.vue`（epub.js），並在 `previews/index.ts` 註冊。
- PWA：目前已有 `manifest.webmanifest` 與圖示；Service Worker（vite-plugin-pwa）注意不要快取 `/api/*`。
- i18n：字串集中在 `i18n/zh-TW.ts`；`t(key, params)` 介面固定，可替換為 vue-i18n。
