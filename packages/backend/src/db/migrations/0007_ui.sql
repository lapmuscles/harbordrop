-- 0007_ui：匿名操作速率限制（固定一小時視窗，每 IP 每種動作一筆）
CREATE TABLE IF NOT EXISTS anon_rate (
  key TEXT PRIMARY KEY,                   -- <kind>|<ip>，kind = upload | paste
  window_start INTEGER NOT NULL,          -- 視窗起點（Unix 毫秒，對齊整點）
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anon_rate_updated ON anon_rate(updated_at);
