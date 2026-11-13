import Database from "better-sqlite3";
import { createApp } from "../../src/app";
import { createContext, type AppContext } from "../../src/core/context";
import { createSqliteDb } from "../../src/db/sqlite";
import { DRIVERS } from "../../src/storage/registry";
import { memoryDriver } from "./memory-driver";

if (!DRIVERS.includes(memoryDriver)) DRIVERS.push(memoryDriver);

export async function makeApp(env: Record<string, string> = {}) {
  const db = createSqliteDb(new Database(":memory:"));
  const ctx: AppContext = await createContext(db, { APP_SECRET: "test-secret-0123456789", ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "pass-1234", ...env }, "node");
  const app = createApp(async () => ctx);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body instanceof Uint8Array) init.body = body as BodyInit;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as any)["content-type"] = "application/json";
    }
    const res = await app.fetch(new Request(`http://local${path}`, init));
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  const login = async () => (await call("POST", "/api/auth/login", { username: "admin", password: "pass-1234" })).json.token as string;
  return { app, ctx, call, login };
}
