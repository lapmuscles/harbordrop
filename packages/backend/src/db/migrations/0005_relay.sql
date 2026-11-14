-- feat/chunk-relay：分片中繼渠道（Telegram、Discord）的檔案清單
-- 這類渠道本身沒有目錄結構，列目錄／刪除一律以本表為準。
CREATE TABLE IF NOT EXISTS relay_objects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  storage_id INTEGER NOT NULL REFERENCES storages(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                     -- 儲存內相對路徑（/ 開頭）
  size INTEGER NOT NULL,
  mime TEXT,
  chunks TEXT NOT NULL,                   -- JSON：[{ index, size, ref }]，依 index 排序
  created_at INTEGER NOT NULL,
  UNIQUE (storage_id, path)
);
CREATE INDEX IF NOT EXISTS idx_relay_objects_storage_path ON relay_objects(storage_id, path);

-- 上傳中（尚未完成）的分片；每片一列，平行上傳不會互相覆寫
CREATE TABLE IF NOT EXISTS relay_upload_chunks (
  session_id TEXT NOT NULL,
  storage_id INTEGER NOT NULL REFERENCES storages(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  size INTEGER NOT NULL,
  ref TEXT NOT NULL,                      -- JSON：渠道端的分片參照（file_id、message_id 等）
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, idx)
);
