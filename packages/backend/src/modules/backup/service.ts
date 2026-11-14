import type { AppContext } from "../../core/context";
import { sha256Hex } from "../../core/crypto";
import { badRequest } from "../../core/errors";

export const BACKUP_FORMAT = "harbordrop-backup";
export const BACKUP_VERSION = 1;

/** 匯出／還原的資料表；順序 = 父 → 子（插入順序），刪除時反向 */
export const BACKUP_TABLES = ["settings", "storages", "mounts", "shares", "pastes", "fs_meta", "api_keys", "api_key_acl", "scheduled_jobs"] as const;
export type BackupTable = (typeof BACKUP_TABLES)[number];

type Row = Record<string, string | number | null>;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  /** SHA-256("harbordrop-backup|" + APP_SECRET)：還原時用來判斷 storages.secrets 能否解密 */
  secretFingerprint: string;
  notice: string;
  tables: Partial<Record<BackupTable, Row[]>>;
}

export interface ImportResult {
  mode: "merge" | "replace";
  tables: Record<string, { inserted: number; skipped: number; updated?: number }>;
  warnings: string[];
}

async function fingerprint(ctx: AppContext): Promise<string> {
  return sha256Hex(`harbordrop-backup|${ctx.env.APP_SECRET ?? ""}`);
}

/** 資料表實際欄位（還原時只寫入兩邊都有的欄位，容忍不同版本的結構差異） */
async function columns(ctx: AppContext, table: BackupTable): Promise<Set<string>> {
  const rows = await ctx.db.all<{ name: string }>(`PRAGMA table_info("${table}")`);
  return new Set(rows.map((r) => r.name));
}

export async function exportBackup(ctx: AppContext): Promise<BackupFile> {
  const tables: BackupFile["tables"] = {};
  for (const t of BACKUP_TABLES) {
    tables[t] = await ctx.db.all<Row>(`SELECT * FROM ${t} ORDER BY ${t === "settings" ? "key" : "id"}`);
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    secretFingerprint: await fingerprint(ctx),
    notice: "storages.secrets 仍為加密內容，只有在 APP_SECRET 與匯出時相同的環境才能還原儲存的機密欄位；API 金鑰只含雜湊，原金鑰仍可使用。",
    tables,
  };
}

function isScalar(v: unknown): v is string | number | null {
  return v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
}

/** 檢查備份檔格式；回傳正規化的資料表內容 */
export function validateBackup(data: unknown): BackupFile {
  const d = data as BackupFile;
  if (!d || typeof d !== "object" || d.format !== BACKUP_FORMAT) throw badRequest("不是 HarborDrop 備份檔", "invalid_backup");
  if (typeof d.version !== "number" || d.version > BACKUP_VERSION) throw badRequest("備份檔版本較新，請先升級 HarborDrop", "invalid_backup");
  if (!d.tables || typeof d.tables !== "object") throw badRequest("備份檔缺少資料", "invalid_backup");
  for (const [t, rows] of Object.entries(d.tables)) {
    if (!(BACKUP_TABLES as readonly string[]).includes(t)) throw badRequest(`備份檔含未知資料表：${t}`, "invalid_backup");
    if (!Array.isArray(rows)) throw badRequest(`資料表 ${t} 格式錯誤`, "invalid_backup");
    for (const r of rows) {
      if (!r || typeof r !== "object" || Array.isArray(r)) throw badRequest(`資料表 ${t} 含不合法的列`, "invalid_backup");
      for (const v of Object.values(r)) if (!isScalar(v)) throw badRequest(`資料表 ${t} 含不合法的值`, "invalid_backup");
    }
  }
  return d;
}

function insertSql(table: string, row: Row, cols: Set<string>, opts: { omitId?: boolean; orIgnore?: boolean } = {}) {
  const keys = Object.keys(row).filter((k) => cols.has(k) && !(opts.omitId && k === "id"));
  if (keys.length === 0) return null;
  return {
    sql: `INSERT ${opts.orIgnore ? "OR IGNORE " : ""}INTO ${table} (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    params: keys.map((k) => row[k]),
  };
}

function invalidateCaches(ctx: AppContext) {
  // SettingsService 的快取為私有欄位；還原後需重新讀取
  (ctx.settings as unknown as { cache: unknown }).cache = null;
}

export async function importBackup(ctx: AppContext, raw: unknown, mode: "merge" | "replace"): Promise<ImportResult> {
  const data = validateBackup(raw);
  const result: ImportResult = { mode, tables: {}, warnings: [] };
  const sameSecret = data.secretFingerprint === (await fingerprint(ctx));
  const tables: Partial<Record<BackupTable, Row[]>> = {};
  for (const t of BACKUP_TABLES) tables[t] = (data.tables[t] ?? []).map((r) => ({ ...r }));
  if (!sameSecret && tables.storages?.some((s) => s.secrets)) {
    for (const s of tables.storages!) s.secrets = null;
    result.warnings.push("APP_SECRET 與備份時不同：儲存的機密欄位（金鑰、密碼）已清空，請在儲存設定重新填寫。");
  }
  const cols: Partial<Record<BackupTable, Set<string>>> = {};
  for (const t of BACKUP_TABLES) cols[t] = await columns(ctx, t);

  if (mode === "replace") {
    const stmts: { sql: string; params?: unknown[] }[] = [];
    for (const t of [...BACKUP_TABLES].reverse()) stmts.push({ sql: `DELETE FROM ${t}` });
    for (const t of BACKUP_TABLES) {
      let n = 0;
      for (const r of tables[t]!) {
        const s = insertSql(t, r, cols[t]!);
        if (s) {
          stmts.push(s);
          n++;
        }
      }
      result.tables[t] = { inserted: n, skipped: tables[t]!.length - n };
    }
    await ctx.db.batch(stmts); // 單一交易：失敗則全部不生效
    invalidateCaches(ctx);
    return result;
  }

  // ── merge：保留現有資料，依自然鍵略過重複；ID 重新配置並改寫外鍵 ──
  const storageMap = new Map<number, number>();
  const mountMap = new Map<number, number>();
  const keyMap = new Map<number, { id: number; isNew: boolean }>();
  const stat = (t: string) => (result.tables[t] ??= { inserted: 0, skipped: 0 });
  const insert = async (t: BackupTable, row: Row) => {
    const s = insertSql(t, row, cols[t]!, { omitId: true });
    if (!s) return null;
    const r = await ctx.db.run(s.sql, s.params);
    stat(t).inserted++;
    return r.lastRowId;
  };

  // settings：以備份值覆寫
  for (const r of tables.settings!) {
    if (typeof r.key !== "string" || typeof r.value !== "string") {
      stat("settings").skipped++;
      continue;
    }
    const exists = await ctx.db.first("SELECT key FROM settings WHERE key = ?", [r.key]);
    await ctx.db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [r.key, r.value, Number(r.updated_at) || Date.now()],
    );
    const s = stat("settings");
    if (exists) s.updated = (s.updated ?? 0) + 1;
    else s.inserted++;
  }

  // storages：名稱 + 類型相同視為同一個
  for (const r of tables.storages!) {
    const ex = await ctx.db.first<{ id: number }>("SELECT id FROM storages WHERE name = ? AND type = ?", [r.name, r.type]);
    if (ex) {
      storageMap.set(Number(r.id), ex.id);
      stat("storages").skipped++;
    } else {
      const id = await insert("storages", { ...r, is_default: 0 });
      if (id != null) storageMap.set(Number(r.id), id);
    }
  }
  const mapStorage = (v: unknown) => (v == null ? null : (storageMap.get(Number(v)) ?? undefined));

  // mounts：mount_path 相同略過
  for (const r of tables.mounts!) {
    const ex = await ctx.db.first<{ id: number }>("SELECT id FROM mounts WHERE mount_path = ?", [r.mount_path]);
    const sid = mapStorage(r.storage_id);
    if (ex) {
      mountMap.set(Number(r.id), ex.id);
      stat("mounts").skipped++;
    } else if (sid == null) {
      stat("mounts").skipped++;
    } else {
      const id = await insert("mounts", { ...r, storage_id: sid });
      if (id != null) mountMap.set(Number(r.id), id);
    }
  }

  // shares / pastes：slug 相同略過；fs_meta：path 相同略過
  for (const [t, natural] of [
    ["shares", "slug"],
    ["pastes", "slug"],
    ["fs_meta", "path"],
  ] as const) {
    for (const r of tables[t]!) {
      if (await ctx.db.first(`SELECT id FROM ${t} WHERE ${natural} = ?`, [r[natural]])) {
        stat(t).skipped++;
        continue;
      }
      const row = { ...r };
      if (t === "shares") row.storage_id = mapStorage(r.storage_id) ?? null;
      await insert(t, row);
    }
  }

  // api_keys：key_hash 相同略過；ACL 只寫入新增的金鑰
  for (const r of tables.api_keys!) {
    const ex = await ctx.db.first<{ id: number }>("SELECT id FROM api_keys WHERE key_hash = ?", [r.key_hash]);
    if (ex) {
      keyMap.set(Number(r.id), { id: ex.id, isNew: false });
      stat("api_keys").skipped++;
    } else {
      const id = await insert("api_keys", r);
      if (id != null) keyMap.set(Number(r.id), { id, isNew: true });
    }
  }
  for (const r of tables.api_key_acl!) {
    const k = keyMap.get(Number(r.api_key_id));
    const sid = r.storage_id == null ? null : storageMap.get(Number(r.storage_id));
    const mid = r.mount_id == null ? null : mountMap.get(Number(r.mount_id));
    if (!k?.isNew || sid === undefined || mid === undefined) {
      stat("api_key_acl").skipped++;
      if (k?.isNew) result.warnings.push(`API 金鑰 #${k.id} 有 ACL 規則引用不存在的儲存或掛載，已略過該規則。`);
      continue;
    }
    await insert("api_key_acl", { ...r, api_key_id: k.id, storage_id: sid, mount_id: mid });
  }

  // scheduled_jobs：kind + name 相同略過
  for (const r of tables.scheduled_jobs!) {
    if (await ctx.db.first("SELECT id FROM scheduled_jobs WHERE kind = ? AND name = ?", [r.kind, r.name])) {
      stat("scheduled_jobs").skipped++;
      continue;
    }
    await insert("scheduled_jobs", r);
  }
  for (const t of BACKUP_TABLES) stat(t);
  invalidateCaches(ctx);
  return result;
}

/** 預設備份檔名：harbordrop-backup-YYYYMMDD-HHMMSS.json（UTC） */
export function backupFilename(at: number): string {
  const s = new Date(at).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `harbordrop-backup-${s}.json`;
}

/**
 * jobs kind：backup.export。config：{ storageId: number, path: string }
 * path 以 / 結尾（或空白）時視為資料夾，自動加上帶時間的檔名；path 中的 {date} 會換成 YYYYMMDD-HHMMSS。
 * 以驅動 put() 寫入，需該儲存支援經後端上傳。
 */
export async function exportBackupJob(ctx: AppContext, config: Record<string, unknown>): Promise<string> {
  const storageId = Number(config.storageId);
  if (!Number.isInteger(storageId) || storageId <= 0) throw new Error("config.storageId 必須是儲存 ID");
  const data = await exportBackup(ctx);
  const fname = backupFilename(data.exportedAt);
  let path = typeof config.path === "string" ? config.path.trim() : "";
  if (!path || path.endsWith("/")) path = `${path || "/"}${fname}`;
  path = path.replace(/\{date\}/g, fname.slice("harbordrop-backup-".length, -".json".length));
  if (!path.startsWith("/")) path = "/" + path;
  if (path.split("/").some((s) => s === "..")) throw new Error("路徑不正確");
  const driver = await ctx.storage.driver(storageId);
  if (!driver.put) throw new Error("此儲存不支援經後端寫入，無法匯出備份");
  const body = new TextEncoder().encode(JSON.stringify(data, null, 2));
  if (driver.capabilities.maxProxyUploadBytes !== undefined && body.byteLength > driver.capabilities.maxProxyUploadBytes) {
    throw new Error("備份檔超過此儲存的單檔上限");
  }
  await driver.put(path, body, { size: body.byteLength, mime: "application/json" });
  return `已匯出備份到儲存 #${storageId}：${path}（${body.byteLength} 位元組）`;
}
