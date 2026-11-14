-- 搜尋（search 模組）。search_index 表已於 0001_init 建立（path = 虛擬完整路徑）。
-- 全文索引表 search_fts（FTS5，rowid = search_index.id）於執行期建立：優先 tokenize='trigram'（支援中文子字串），
-- 不支援時退回 unicode61，再不行則只用 search_index 的 LIKE 查詢。見 modules/search/service.ts 的 ensureFts()。
CREATE INDEX IF NOT EXISTS idx_search_path ON search_index(path);
