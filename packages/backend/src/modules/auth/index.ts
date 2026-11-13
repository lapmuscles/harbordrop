import type { HdModule } from "../types";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "../../core/crypto";
import { badRequest, unauthorized } from "../../core/errors";
import { requireAdmin, SESSION_COOKIE } from "../../core/auth";
import { setCookie, deleteCookie } from "hono/cookie";

/** 管理員登入／登出／身分。session token 以 SHA-256 存放 */
export const authModule: HdModule = {
  name: "auth",
  routes(app) {
    app.post("/api/auth/login", async (c) => {
      const ctx = c.get("ctx");
      const { username, password } = await c.req.json<{ username?: string; password?: string }>();
      if (!username || !password) throw badRequest("請輸入帳號與密碼");
      const admin = await ctx.db.first<{ id: number; password_hash: string }>("SELECT id, password_hash FROM admins WHERE username = ?", [username]);
      // 帳號不存在時仍做一次雜湊，避免以回應時間推測帳號
      const ok = await verifyPassword(password, admin?.password_hash ?? "pbkdf2$sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");
      if (!admin || !ok) throw unauthorized("帳號或密碼錯誤", "invalid_credentials");
      const token = randomToken();
      const ttlH = Number(ctx.env.SESSION_TTL_HOURS) || 24 * 7;
      const expires = Date.now() + ttlH * 3600_000;
      await ctx.db.run("DELETE FROM sessions WHERE expires_at < ?", [Date.now()]);
      await ctx.db.run("INSERT INTO sessions (token_hash, admin_id, expires_at, created_at, user_agent) VALUES (?, ?, ?, ?, ?)", [
        await sha256Hex(token),
        admin.id,
        expires,
        Date.now(),
        c.req.header("user-agent")?.slice(0, 200) ?? null,
      ]);
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        secure: new URL(c.req.url).protocol === "https:",
        maxAge: ttlH * 3600,
      });
      return c.json({ token, expiresAt: expires, username });
    });

    app.post("/api/auth/logout", async (c) => {
      const ctx = c.get("ctx");
      const auth = c.req.header("authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
      const cookie = c.req.header("cookie")?.match(new RegExp(`${SESSION_COOKIE}=([0-9a-f]{64})`))?.[1];
      for (const t of [token, cookie]) if (t) await ctx.db.run("DELETE FROM sessions WHERE token_hash = ?", [await sha256Hex(t)]);
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ ok: true });
    });

    app.get("/api/auth/me", (c) => {
      const p = c.get("principal");
      return c.json({ kind: p.kind, username: p.kind === "admin" ? p.username : p.kind === "apikey" ? p.name : undefined });
    });

    app.post("/api/auth/password", async (c) => {
      const me = requireAdmin(c);
      const ctx = c.get("ctx");
      const { oldPassword, newPassword } = await c.req.json<{ oldPassword: string; newPassword: string }>();
      if (!newPassword || newPassword.length < 8) throw badRequest("新密碼至少 8 個字元");
      const row = await ctx.db.first<{ password_hash: string }>("SELECT password_hash FROM admins WHERE id = ?", [me.id]);
      if (!(await verifyPassword(oldPassword ?? "", row?.password_hash))) throw unauthorized("舊密碼錯誤", "invalid_credentials");
      await ctx.db.run("UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?", [await hashPassword(newPassword), Date.now(), me.id]);
      return c.json({ ok: true });
    });
  },
};
