import type { Hono } from "hono";
import type { AppContext, AppEnv, HdContext } from "../core/context";
import type { Principal } from "../core/auth";
import type { SettingDef } from "../core/settings";

/**
 * 功能模組。每個功能一個資料夾 modules/<name>/index.ts，匯出 HdModule，
 * 並加入 modules/index.ts 的 MODULES 陣列。模組之間不互相 import 內部檔案，
 * 只透過 AppContext（db / storage / settings）與共用 helper（core/*、storage/*）。
 */
export interface HdModule {
  name: string;
  /** 掛載路由（路徑前綴規範見 docs/ARCHITECTURE-zhTW.md） */
  routes?(app: Hono<AppEnv>): void;
  /** 新增系統設定 */
  settings?: SettingDef[];
  /** 額外的身分驗證（例如 API 金鑰）；回傳 null 表示不處理 */
  authenticate?(c: HdContext): Promise<Principal | null>;
  /** 排程喚醒（Workers Cron Trigger 每分鐘、Node 每分鐘）；請自行判斷是否到期並快速返回 */
  cron?(ctx: AppContext): Promise<void>;
  /** scheduled_jobs.kind → 執行函式（jobs 模組負責排程與記錄） */
  jobs?: Record<string, (ctx: AppContext, config: Record<string, unknown>) => Promise<string | void>>;
}
