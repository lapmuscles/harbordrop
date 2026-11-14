import type { Hono } from "hono";
import type { AppEnv, HdContext } from "../../core/context";
import { requireAdmin } from "../../core/auth";
import { badRequest } from "../../core/errors";
import { signToken, verifyToken } from "../../core/sign";
import { getDriverDef } from "../../storage/registry";

/**
 * 儲存渠道 OAuth 授權（feat/ms-google）：
 *   GET /api/admin/storages/oauth/:type/start?storageId=N[&format=json]
 *     管理員；先建立好該儲存（含 Client ID / Secret，refresh token 可留空），302 轉往供應商授權頁
 *   GET /api/admin/storages/oauth/:type/callback?code=…&state=…
 *     供應商轉回；以簽章 state 驗證（不依賴 cookie），換得 refresh token 後加密寫回該儲存的機密欄位。
 *     refresh token 永不顯示在頁面或回應中。
 */

const STATE_TTL = 15 * 60;

function publicOrigin(c: HdContext): string {
  const env = c.get("ctx").env.PUBLIC_URL;
  if (env) return env.replace(/\/+$/, "");
  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? u.host;
  return `${proto}://${host}`;
}

const redirectUri = (c: HdContext, type: string) => `${publicOrigin(c)}/api/admin/storages/oauth/${encodeURIComponent(type)}/callback`;
const purpose = (type: string, id: number) => `storage-oauth|${type}|${id}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(c: HdContext, ok: boolean, msg: string) {
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? "授權成功" : "授權失敗"}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${ok ? "✅ 授權成功" : "❌ 授權失敗"}</h1><p>${esc(msg)}</p><p><a href="/admin/storages">返回儲存設定</a></p><script>try{window.opener&&window.opener.postMessage({type:"hd-storage-oauth",ok:${ok}},location.origin)}catch(e){}</script></body></html>`;
  return c.html(html, ok ? 200 : 400);
}

export function mountStorageOAuth(app: Hono<AppEnv>) {
  app.get("/api/admin/storages/oauth/:type/start", async (c) => {
    requireAdmin(c);
    const ctx = c.get("ctx");
    const type = c.req.param("type");
    const def = getDriverDef(type);
    if (!def?.oauth) throw badRequest("此儲存類型不支援 OAuth 授權");
    const id = Number(c.req.query("storageId"));
    if (!id) throw badRequest("請先儲存設定（需要 storageId）");
    const row = await ctx.storage.row(id);
    if (row.type !== type) throw badRequest("儲存類型不符");
    const config = { ...JSON.parse(row.config), ...(await ctx.box.open(row.secrets)) };
    const state = `${id}.${await signToken(ctx.env.APP_SECRET ?? "", purpose(type, id), STATE_TTL)}`;
    const url = def.oauth.authorizeUrl({ config, redirectUri: redirectUri(c, type), state });
    if (c.req.query("format") === "json") return c.json({ url, redirectUri: redirectUri(c, type) });
    return c.redirect(url, 302);
  });

  app.get("/api/admin/storages/oauth/:type/callback", async (c) => {
    const ctx = c.get("ctx");
    const type = c.req.param("type");
    const def = getDriverDef(type);
    if (!def?.oauth) return page(c, false, "此儲存類型不支援 OAuth 授權");
    const err = c.req.query("error");
    if (err) return page(c, false, `供應商回報：${c.req.query("error_description") || err}`);
    const state = c.req.query("state") ?? "";
    const dot = state.indexOf(".");
    const id = Number(state.slice(0, dot));
    if (!id || !(await verifyToken(ctx.env.APP_SECRET ?? "", purpose(type, id), state.slice(dot + 1)))) return page(c, false, "授權狀態無效或已過期，請重新開始授權");
    const code = c.req.query("code");
    if (!code) return page(c, false, "缺少授權碼");
    let row;
    try {
      row = await ctx.storage.row(id);
    } catch {
      return page(c, false, "找不到對應的儲存設定");
    }
    if (row.type !== type) return page(c, false, "儲存類型不符");
    const config = JSON.parse(row.config);
    try {
      const { refreshToken } = await def.oauth.exchangeCode({ config: { ...config, ...(await ctx.box.open(row.secrets)) }, redirectUri: redirectUri(c, type), code, fetch: ctx.driverCtx.fetch });
      const { sealed } = await ctx.storage.split(type, { ...config, [def.oauth.tokenField]: refreshToken }, row.secrets);
      await ctx.db.run("UPDATE storages SET secrets = ?, updated_at = ? WHERE id = ?", [sealed, Math.max(Date.now(), row.updated_at + 1), id]);
      ctx.storage.invalidate(id);
    } catch (e: any) {
      return page(c, false, e?.message ?? String(e));
    }
    return page(c, true, `「${row.name}」已取得 refresh token，可關閉此頁並按「測試連線」。`);
  });
}
