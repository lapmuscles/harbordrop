import { Hono, type MiddlewareHandler } from "hono";
import type { AppContext, AppEnv } from "./core/context";
import { HttpError } from "./core/errors";
import { resolvePrincipal } from "./core/auth";
import { MODULES } from "./modules";

/**
 * 建立 Hono 應用（與執行平台無關）。
 * getCtx：取得 AppContext（Workers 依 env 延遲建立；Node 為單例）
 * staticHandler：非 API 路徑的靜態檔處理（Node 使用；Workers 由 assets 綁定處理）
 */
export function createApp(getCtx: (env: unknown) => Promise<AppContext>, staticHandler?: MiddlewareHandler) {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as any);
    }
    if (err instanceof SyntaxError) return c.json({ error: { code: "bad_json", message: "請求內容格式錯誤" } }, 400);
    console.error("[harbordrop]", err);
    return c.json({ error: { code: "internal", message: "伺服器內部錯誤" } }, 500);
  });

  app.use("/api/*", async (c, next) => {
    c.set("ctx", await getCtx(c.env));
    c.set("principal", await resolvePrincipal(c as any));
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("/dav/*", async (c, next) => {
    c.set("ctx", await getCtx(c.env));
    c.set("principal", await resolvePrincipal(c as any));
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true, platform: c.get("ctx").platform }));

  // 模組路由（MODULES 為靜態清單）
  for (const m of MODULES) m.routes?.(app);

  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "找不到 API" } }, 404));
  if (staticHandler) app.use("*", staticHandler);
  return app;
}

/** 排程喚醒：依序呼叫各模組的 cron() */
export async function runCron(ctx: AppContext) {
  for (const m of ctx.modules) {
    if (!m.cron) continue;
    try {
      await m.cron(ctx);
    } catch (e) {
      console.error(`[cron:${m.name}]`, e);
    }
  }
}
