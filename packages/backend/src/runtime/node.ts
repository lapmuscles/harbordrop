import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, runCron } from "../app";
import { createContext } from "../core/context";
import { createSqliteDb } from "../db/sqlite";
import type { MiddlewareHandler } from "hono";

/** Node／Docker 進入點：SQLite + 靜態前端 + 每分鐘排程 */
export async function startNode() {
  const env = process.env as Record<string, string | undefined>;
  const dataDir = resolve(env.DATA_DIR ?? "./data");
  mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(join(dataDir, "harbordrop.db"));
  const ctx = await createContext(createSqliteDb(sqlite), env, "node", { dataDir });

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [env.STATIC_DIR, join(here, "../public"), join(here, "../../frontend/dist"), join(here, "../../../frontend/dist")].filter(Boolean) as string[];
  const staticDir = candidates.find((d) => existsSync(join(d, "index.html")));
  let staticHandler: MiddlewareHandler | undefined;
  if (staticDir) {
    const indexHtml = readFileSync(join(staticDir, "index.html"), "utf8");
    const files = serveStatic({ root: staticDir });
    staticHandler = async (c, next) => {
      const r = await files(c, async () => {});
      if (r) return r;
      if (c.req.method === "GET" && !/\.[a-z0-9]+$/i.test(c.req.path)) return c.html(indexHtml); // SPA 後備
      await next();
    };
  }

  const app = createApp(async () => ctx, staticHandler);
  const port = Number(env.PORT) || 8787;
  const server = serve({ fetch: app.fetch, port, hostname: env.HOST ?? "0.0.0.0" });
  const timer = setInterval(() => runCron(ctx), 60_000);
  console.log(`HarborDrop 已啟動：http://localhost:${port}（資料：${dataDir}，前端：${staticDir ?? "未建置"}）`);
  return {
    ctx,
    port,
    close: () => {
      clearInterval(timer);
      server.close();
      sqlite.close();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startNode().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
