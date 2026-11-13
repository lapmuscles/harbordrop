import type { Db } from "../db/adapter";

/**
 * 系統設定定義。模組可在自己的 HdModule.settings 加入定義（見 modules/types.ts），
 * public = true 的設定會出現在 GET /api/public/config。
 */
export interface SettingDef {
  key: string;
  default: unknown;
  public?: boolean;
  label: string;
}

export const CORE_SETTINGS: SettingDef[] = [
  { key: "siteTitle", default: "HarborDrop", public: true, label: "網站名稱" },
  { key: "allowAnonymousUpload", default: false, public: true, label: "允許匿名上傳" },
  { key: "anonymousMaxBytes", default: 0, public: true, label: "匿名上傳單檔上限（位元組，0 = 不限）" },
  { key: "anonymousMaxExpiryHours", default: 168, label: "匿名分享最長有效時數（0 = 不限）" },
  { key: "uploadPathTemplate", default: "/{yyyy}/{mm}/{dd}/{rand}/{name}", label: "上傳路徑範本" },
];

export class SettingsService {
  private cache: Map<string, unknown> | null = null;
  constructor(
    private db: Db,
    private defs: SettingDef[],
  ) {}

  async all(): Promise<Record<string, unknown>> {
    if (!this.cache) {
      const rows = await this.db.all<{ key: string; value: string }>("SELECT key, value FROM settings");
      this.cache = new Map(rows.map((r) => [r.key, JSON.parse(r.value)]));
    }
    const out: Record<string, unknown> = {};
    for (const d of this.defs) out[d.key] = this.cache.has(d.key) ? this.cache.get(d.key) : d.default;
    return out;
  }
  async get<T = unknown>(key: string): Promise<T> {
    return (await this.all())[key] as T;
  }
  async publicValues(): Promise<Record<string, unknown>> {
    const all = await this.all();
    return Object.fromEntries(this.defs.filter((d) => d.public).map((d) => [d.key, all[d.key]]));
  }
  async update(values: Record<string, unknown>): Promise<void> {
    const known = new Set(this.defs.map((d) => d.key));
    const now = Date.now();
    const stmts = Object.entries(values)
      .filter(([k]) => known.has(k))
      .map(([k, v]) => ({
        sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params: [k, JSON.stringify(v), now],
      }));
    if (stmts.length) await this.db.batch(stmts);
    this.cache = null;
  }
  definitions() {
    return this.defs;
  }
}
