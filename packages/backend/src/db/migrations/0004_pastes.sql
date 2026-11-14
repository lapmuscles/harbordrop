-- 文字分享（模組：pastes）：補欄位與索引（pastes 表已於 0001_init 建立）
ALTER TABLE pastes ADD COLUMN remark TEXT;
ALTER TABLE pastes ADD COLUMN size INTEGER NOT NULL DEFAULT 0; -- 內容 UTF-8 位元組數
CREATE INDEX IF NOT EXISTS idx_pastes_created ON pastes(created_at);
CREATE INDEX IF NOT EXISTS idx_pastes_expires ON pastes(expires_at);
