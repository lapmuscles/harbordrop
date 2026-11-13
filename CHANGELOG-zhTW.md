# 變更紀錄

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
