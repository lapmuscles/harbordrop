-- HarborDrop 完整資料表結構（涵蓋全部功能模組；尚未實作的模組亦先定好表，供平行開發）
-- 規則：時間一律存 Unix 毫秒（INTEGER）；JSON 存 TEXT；布林存 0/1。
-- 同一份 SQL 同時用於 Cloudflare D1 與 better-sqlite3（SQLite 3.4x），勿使用專屬語法。

-- ───────── 核心：帳號與權限 ─────────
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,            -- pbkdf2$sha256$<iter>$<salt_b64>$<hash_b64>
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,            -- SHA-256(token) hex；明文 token 只回給瀏覽器一次
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- API 金鑰（模組：apikeys）
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,               -- 顯示用前 8 碼，例如 hd_ab12cd
  key_hash TEXT NOT NULL UNIQUE,          -- SHA-256(key) hex
  permissions TEXT NOT NULL DEFAULT '[]', -- JSON：全域權限 ["upload","share","paste","fs.read","fs.write","webdav", ...]
  enabled INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- API 金鑰的儲存／路徑 ACL（模組：apikeys）。storage_id 與 mount_id 擇一；path_prefix 為該範圍內的前綴
CREATE TABLE IF NOT EXISTS api_key_acl (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  storage_id INTEGER REFERENCES storages(id) ON DELETE CASCADE,
  mount_id INTEGER REFERENCES mounts(id) ON DELETE CASCADE,
  path_prefix TEXT NOT NULL DEFAULT '/',
  perms TEXT NOT NULL DEFAULT '["read"]'  -- JSON：read / write / delete / list
);
CREATE INDEX IF NOT EXISTS idx_acl_key ON api_key_acl(api_key_id);

-- 系統設定（鍵值）。值為 JSON 字串
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ───────── 儲存 ─────────
-- type：s3 | huggingface | onedrive | gdrive | webdav | local | github | telegram | discord | mirror
CREATE TABLE IF NOT EXISTS storages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',      -- JSON：非機密欄位（可回傳瀏覽器）
  secrets TEXT,                           -- AES-GCM 加密後的 JSON（機密欄位），永不回傳
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  allow_anonymous_upload INTEGER NOT NULL DEFAULT 0, -- 匿名上傳時可選此儲存
  remark TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 掛載（模組：mounts / fs）：把儲存的某個根目錄掛到虛擬路徑
CREATE TABLE IF NOT EXISTS mounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mount_path TEXT NOT NULL UNIQUE,        -- 例如 /hf、/photos/2025
  storage_id INTEGER NOT NULL REFERENCES storages(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL DEFAULT '/',
  readonly INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  web_proxy INTEGER NOT NULL DEFAULT 0,   -- 1 = 下載一律經後端代理
  cache_ttl INTEGER NOT NULL DEFAULT 0,   -- 目錄列表快取秒數
  sort INTEGER NOT NULL DEFAULT 0,
  options TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ───────── 上傳與分享 ─────────
-- 上傳工作階段：瀏覽器直傳的狀態機（init → uploading → committed/completed | aborted | failed）
CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,                    -- 隨機 ID（也是上傳權杖的一部分）
  token_hash TEXT NOT NULL,               -- SHA-256(上傳權杖)，匿名上傳者憑此續傳
  storage_id INTEGER NOT NULL REFERENCES storages(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,                 -- xet | s3-multipart | proxy | chunk-relay …（由驅動決定）
  object_path TEXT NOT NULL,              -- 儲存內完整路徑
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT,
  sha256 TEXT,
  state TEXT NOT NULL DEFAULT 'init',
  provider_upload_id TEXT,                -- 例如 S3 UploadId
  part_size INTEGER,
  meta TEXT NOT NULL DEFAULT '{}',        -- JSON：驅動私有狀態（例如 HF commit oid）
  share_options TEXT NOT NULL DEFAULT '{}', -- JSON：完成時建立分享用（slug/密碼雜湊/到期/次數）
  created_by TEXT NOT NULL,               -- admin:<id> | apikey:<id> | anon
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_expires ON upload_sessions(expires_at);

-- 分享（檔案分享頁 /f/:slug）
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  storage_id INTEGER REFERENCES storages(id) ON DELETE SET NULL,
  object_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT,
  sha256 TEXT,
  password_hash TEXT,
  expires_at INTEGER,
  max_views INTEGER,                      -- NULL = 不限
  views INTEGER NOT NULL DEFAULT 0,
  remark TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_created ON shares(created_at);

-- 文字分享（模組：pastes）
CREATE TABLE IF NOT EXISTS pastes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT,
  content TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'markdown', -- markdown | text | code:<lang>
  password_hash TEXT,
  expires_at INTEGER,
  max_views INTEGER,
  views INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ───────── 檔案系統附加資料 ─────────
-- 目錄 meta（模組：fs-meta）：虛擬路徑上的 readme／header、密碼、隱藏規則
CREATE TABLE IF NOT EXISTS fs_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,              -- 虛擬路徑，例如 /hf/models
  header_md TEXT,
  readme_md TEXT,
  password_hash TEXT,
  hide_patterns TEXT NOT NULL DEFAULT '[]', -- JSON：glob 陣列
  apply_to_children INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 搜尋索引（模組：search）。以掛載為單位重建
CREATE TABLE IF NOT EXISTS search_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mount_id INTEGER NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                     -- 虛擬完整路徑
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  is_dir INTEGER NOT NULL DEFAULT 0,
  size INTEGER,
  modified_at INTEGER,
  indexed_at INTEGER NOT NULL,
  UNIQUE(mount_id, path)
);
CREATE INDEX IF NOT EXISTS idx_search_name ON search_index(name_lower);

-- ───────── 排程與背景工作 ─────────
-- 排程（模組：jobs）：kind 例如 cleanup.expired、search.reindex、backup.export、mirror.sync
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,      -- Workers 由 Cron Trigger（每分鐘）喚醒，再依此判斷是否到期
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  last_status TEXT,
  last_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 背景工作清單（模組：tasks）：複製／搬移／重建索引／備份等長時間工作
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | succeeded | failed | cancelled
  progress INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);
