/// <reference types="@cloudflare/workers-types" />
import { createApp, runCron } from "../app";
import { createContext, type AppContext, type RuntimeEnv } from "../core/context";
import { createD1Db } from "../db/d1";

interface WorkerEnv extends RuntimeEnv {
  DB: D1Database;
  ASSETS: Fetcher;
}

let ctxP: Promise<AppContext> | null = null;
function getCtx(env: WorkerEnv): Promise<AppContext> {
  if (!ctxP) {
    ctxP = createContext(createD1Db(env.DB as any), env, "workers").catch((e) => {
      ctxP = null;
      throw e;
    });
  }
  return ctxP;
}

const app = createApp((env) => getCtx(env as WorkerEnv));

export default {
  async fetch(req: Request, env: WorkerEnv, ectx: ExecutionContext) {
    const path = new URL(req.url).pathname;
    // /api 與 /dav 交給 Hono；其餘由 assets（SPA 後備）處理
    if (path.startsWith("/api/") || path === "/dav" || path.startsWith("/dav/")) return app.fetch(req, env, ectx);
    return env.ASSETS.fetch(req as any);
  },
  async scheduled(_ev: ScheduledEvent, env: WorkerEnv, ectx: ExecutionContext) {
    // Cron Trigger（wrangler.toml [triggers] crons = ["* * * * *"]）：runCron 呼叫 jobs 的 cronTick 與 tasks 的 runTasks
    ectx.waitUntil(getCtx(env).then(runCron));
  },
};
