-- feat/admin：API 金鑰、登入速率限制、TOTP 兩步驟驗證、排程工作
-- api_keys / api_key_acl / scheduled_jobs 已在 0001 預先定義；此處以 IF NOT EXISTS 重申並補索引（對已存在的資料庫無影響）。

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_key_acl (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  storage_id INTEGER REFERENCES storages(id) ON DELETE CASCADE,
  mount_id INTEGER REFERENCES mounts(id) ON DELETE CASCADE,
  path_prefix TEXT NOT NULL DEFAULT '/',
  perms TEXT NOT NULL DEFAULT '["read"]'
);
CREATE INDEX IF NOT EXISTS idx_acl_key ON api_key_acl(api_key_id);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  last_status TEXT,
  last_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON scheduled_jobs(enabled, next_run_at);

-- 登入失敗計數（key = <IP>|<帳號小寫>）。連續失敗 5 次鎖定 15 分鐘
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  first_failed_at INTEGER NOT NULL,
  locked_until INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_updated ON login_attempts(updated_at);

-- 兩步驟登入的暫時挑戰（密碼正確後、TOTP 驗證前）。token 只存 SHA-256
CREATE TABLE IF NOT EXISTS login_challenges (
  token_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 管理員 TOTP（RFC 6238）。秘密以 SecretBox（APP_SECRET）加密存放
ALTER TABLE admins ADD COLUMN totp_secret TEXT;
ALTER TABLE admins ADD COLUMN totp_pending_secret TEXT;
ALTER TABLE admins ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admins ADD COLUMN totp_last_step INTEGER;
