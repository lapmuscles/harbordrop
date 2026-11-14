-- feat/fs：掛載、目錄 meta、背景工作。
-- 三表已在 0001_init 先行定義；此處以 IF NOT EXISTS 重申結構（全新部署或舊庫皆安全），並補上查詢用索引。

CREATE TABLE IF NOT EXISTS mounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mount_path TEXT NOT NULL UNIQUE,
  storage_id INTEGER NOT NULL REFERENCES storages(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL DEFAULT '/',
  readonly INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  web_proxy INTEGER NOT NULL DEFAULT 0,
  cache_ttl INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  options TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mounts_storage ON mounts(storage_id);

CREATE TABLE IF NOT EXISTS fs_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  header_md TEXT,
  readme_md TEXT,
  password_hash TEXT,
  hide_patterns TEXT NOT NULL DEFAULT '[]',
  apply_to_children INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
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
CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind, status);
