import type { Context } from "hono";
import type { Db } from "../db/adapter";
import { migrate } from "../db/migrate";
import { SecretBox, hashPassword } from "./crypto";
import { CORE_SETTINGS, SettingsService } from "./settings";
import { StorageService } from "../storage/service";
import type { DriverContext, Platform } from "../storage/types";
import type { Principal } from "./auth";
import type { HdModule } from "../modules/types";
import { MODULES } from "../modules";

/** 環境變數（Workers：wrangler.toml [vars] / secrets；Node：process.env） */
export interface RuntimeEnv {
  APP_SECRET?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  /** 設為 1 時，啟動時以 ADMIN_PASSWORD 重設該管理員密碼 */
  ADMIN_RESET?: string;
  SESSION_TTL_HOURS?: string;
  /** 對外網址（反向代理後方時用來產生絕對 URL），例如 https://drop.example.com */
  PUBLIC_URL?: string;
}

export interface AppContext {
  db: Db;
  env: RuntimeEnv;
  platform: Platform;
  box: SecretBox;
  settings: SettingsService;
  storage: StorageService;
  modules: HdModule[];
  driverCtx: DriverContext;
}

export interface AppEnv {
  Variables: { ctx: AppContext; principal: Principal };
}
export type HdContext = Context<AppEnv>;

export async function createContext(
  db: Db,
  env: RuntimeEnv,
  platform: Platform,
  extra: Partial<DriverContext> = {},
): Promise<AppContext> {
  await migrate(db);
  const box = new SecretBox(env.APP_SECRET ?? "");
  const driverCtx: DriverContext = { platform, fetch: (...a) => fetch(...a), ...extra };
  const settingDefs = [...CORE_SETTINGS, ...MODULES.flatMap((m) => m.settings ?? [])];
  const ctx: AppContext = {
    db,
    env,
    platform,
    box,
    settings: new SettingsService(db, settingDefs),
    storage: new StorageService(db, box, driverCtx),
    modules: MODULES,
    driverCtx,
  };
  await ensureAdmin(ctx);
  return ctx;
}

/** 首次啟動：依環境變數建立管理員（密碼雜湊後存放） */
async function ensureAdmin(ctx: AppContext) {
  const { ADMIN_USERNAME: u, ADMIN_PASSWORD: p, ADMIN_RESET } = ctx.env;
  if (!u || !p) return;
  const now = Date.now();
  const existing = await ctx.db.first<{ id: number }>("SELECT id FROM admins WHERE username = ?", [u]);
  const count = await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM admins");
  if (!existing && (count?.n ?? 0) === 0) {
    await ctx.db.run("INSERT INTO admins (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)", [u, await hashPassword(p), now, now]);
  } else if (existing && ADMIN_RESET === "1") {
    await ctx.db.run("UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?", [await hashPassword(p), now, existing.id]);
    await ctx.db.run("DELETE FROM sessions WHERE admin_id = ?", [existing.id]);
  }
}
