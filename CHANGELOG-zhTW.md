# 變更紀錄

## 未發佈 — 文件夾上傳

### 新增
- **文件夾上傳（分享流程）**：上傳頁新增「整個資料夾」模式，選擇資料夾（`webkitdirectory`）或拖入資料夾，逐檔上傳、逐檔進度＋整體進度；相對路徑保留在儲存路徑裡，同批檔案共用 `groupId` 落在同一目錄；每檔各自建立分享（沿用既有分享機制，不另開文件夾分享）；單檔失敗不中斷其餘檔案，可重試失敗的檔案；自訂連結不適用於多檔，資料夾模式下停用。支援所有瀏覽器直傳渠道：HuggingFace、S3、Google Drive、OneDrive、Telegram、Discord。
- **文件夾上傳（檔案總管）**：`/files` 新增「上傳資料夾」按鈕，拖入資料夾亦可；每檔依相對路徑放入對應子目錄，沿用既有上傳佇列（並行 2、重試、取消）。經後端代理的渠道（WebDAV、本機、GitHub）也能用，父目錄由驅動自動建立。
- 後端 `POST /api/uploads` 新增選填參數 `relativePath`（相對路徑，逐段清理、拒絕 `..`）與 `groupId`（同批共用的 `{rand}` 替代段）；共用層新增 `uploadFolder()`、`collectFolderFiles()`、`filesFromDataTransfer()`。

### 修正
- OneDrive `initUpload` 會先逐層建好父資料夾（先前巢狀路徑的 `createUploadSession` 可能因父目錄不存在而失敗；分享範本的日期目錄、文件夾上傳的子目錄都受影響）。

## 1.0.1（2026-11-15）— 修正 D1 遷移重跑

### 修正
- 先用 `wrangler d1 migrations apply` 套用遷移後，程式內建的自動遷移會再跑一次。0003、0004 裡沒有保護的 `ALTER TABLE … ADD COLUMN` 因此報 `duplicate column name`，每個請求都失敗，`/api/site` 回 500。
  - 自動遷移會讀取 wrangler 的 `d1_migrations` 紀錄，已套用的遷移不再重跑。
  - 遷移改為逐句執行，欄位已存在的 ADD COLUMN 直接略過；其他錯誤照常拋出。
  - 已部署的資料庫不用手動修，重新部署即可。
- README：說明不需要手動執行 wrangler 遷移。

## 1.0.0（2026-11-14）— 全功能版

### 新增
- **儲存渠道**：WebDAV、本機（僅 Node／Docker）、GitHub（Contents API，>1000 項改用 Git Trees）、Telegram（每片 ≤20MB）、Discord（預設 8MiB／片）、OneDrive（Graph 上傳工作階段直傳，global／cn、個人／商務／SharePoint）、Google Drive（resumable 直傳）、唯讀鏡像（Apache／Nginx 目錄索引、GitHub Releases）。連同既有 S3、HuggingFace 共 10 種驅動。
- **分片中繼協定 chunk-relay**：瀏覽器逐片上傳經後端轉送，失敗只重傳該片、可續傳；`relay_objects` 存分片清單，下載串接並支援 Range。
- **OAuth 授權**：OneDrive／Google Drive 在儲存頁一鍵授權取得 refresh token（簽章 state、加密存放）。
- **掛載與檔案總管**：虛擬目錄、`/files` 檔案總管（清單／格狀、排序、多選、拖曳上傳佇列、重新命名、複製、搬移、刪除、分享、預覽、目錄密碼解鎖、README／header）；跨儲存複製搬移走背景任務。
- **目錄規則（fs meta）**：隱藏、密碼、套用子目錄，所有祖先皆檢查。
- **背景任務與排程**：任務列表（進度、取消）；排程工作（cleanup.expired、search.reindex、backup.export、pastes.cleanup），Workers Cron 與 Node 每 60 秒推進。
- **WebDAV 伺服器** `/dav`：PROPFIND、GET（Range）、PUT、DELETE、MKCOL、MOVE、COPY、假 LOCK；Basic Auth（管理員或 API 金鑰），依 ACL 檢查。
- **搜尋**：SQLite FTS5（trigram，不支援時退回 unicode61／LIKE），分段重建索引。
- **API 金鑰與 ACL**：權限 + 路徑前綴、路徑穿越防護。
- **帳號安全**：登入失敗 5 次鎖 15 分鐘、TOTP 兩步驟、修改密碼；`TRUST_PROXY` 控制是否信任代理標頭。
- **備份還原**：JSON 匯出、merge／replace 匯入；可排程匯出到儲存。
- **Paste**：Markdown／程式碼文字分享，密碼、到期、次數上限；匿名建立可開關並限流。
- **預覽**：Markdown、程式碼高亮、Word／Excel／CSV（本地）、PowerPoint（同意後用 Office Online）、EPUB。
- **管理儀表板、站台設定（站名、公告、頁尾、匿名上限）、PWA（不快取 /api、/dav）**。

## 0.1.0（2026-11-13）— 核心版

全新重寫（不沿用 cloudharbor 程式碼）。

### 新增
- **架構**：npm workspaces 單一倉庫（`shared`／`backend`／`frontend`）；Hono 後端同時支援 Cloudflare Workers（D1、assets、Cron）與 Node／Docker（better-sqlite3）；薄 DB 介面讓同一份 SQL 在兩邊執行；啟動時自動遷移。
- **完整資料表**：一次定義全部功能所需表（管理員、session、API 金鑰與 ACL、設定、儲存、掛載、上傳工作階段、分享、文字分享、目錄 meta、搜尋索引、排程、背景工作）。
- **模組化**：功能模組介面 `HdModule`（routes／settings／authenticate／cron／jobs）、儲存驅動介面 `StorageDriver`；尚未實作的模組已保留路由並回應 501。
- **管理員登入**：環境變數首次建立、PBKDF2 雜湊、session token 雜湊存放、HttpOnly cookie 或 Bearer。
- **儲存設定 CRUD**：HuggingFace（dataset／model、分支、路徑前綴、下載方式）與 S3 相容儲存；機密欄位 AES-256-GCM 加密、永不回傳；依欄位定義自動產生表單；測試連線。
- **上傳並分享**：自訂／隨機連結、密碼、有效期限、最多瀏覽次數；匿名上傳開關、逐儲存允許、大小上限、最長有效期。
- **HuggingFace Xet 瀏覽器直傳**：使用 @huggingface/hub（wasm 切塊）+ 後端工作階段 hub 代理；HF token 不進瀏覽器（後端換發短效 xet 寫入權杖）；commit 由後端驗證 sha256／大小後自行提交；每個 xorb 獨立指數退避重試；xorb 級續傳。
- **S3 multipart 直傳**：預簽章分片、可設定分片大小（預設 16MB）與並行數（預設 4）、分片獨立重試、簽章過期自動重簽、以 ListParts 續傳。
- **分享頁 `/f/:slug`**：圖片／影片／音訊／文字／PDF 預覽、密碼解鎖（短效 HMAC 權杖）、原子計次、到期與次數上限；HF 公開倉庫轉址、私有倉庫代理串流（Range），S3 預簽章 GET。
- 正體中文介面與文件、PWA manifest。

### 安全
- HuggingFace LFS batch 回應中的 `verify` 動作標頭含 **HF token 明文**；hub 代理會移除 `verify` 與所有 `Authorization` 標頭，並有單元測試與瀏覽器實測守護。

### 測試
- vitest 34 項（資料庫、加密、ACL、上傳／分享 API 流程、HF 代理安全、S3 客戶端重試與續傳）。
- 真實環境：HF Xet 2,000,000,777 位元組上傳／驗證／分享下載／刪除；Chromium 實際前端上傳 200MB（含 xorb 網路中斷重試）；本機 S3 相容伺服器（moto）multipart；`wrangler dev` 本機 Workers 執行期；`wrangler deploy --dry-run`；Node 建置版啟動測試。
