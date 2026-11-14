import type { HdModule } from "../types";
import type { AppContext, HdContext } from "../../core/context";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "../../core/crypto";
import { badRequest, conflict, unauthorized } from "../../core/errors";
import { requireAdmin, SESSION_COOKIE } from "../../core/auth";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../../core/totp";
import { assertNotLocked, attemptKey, clearFailures, clientIp, recordFailure, tooMany } from "./ratelimit";

const DUMMY_HASH = "pbkdf2$sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAA";
const CHALLENGE_TTL_MS = 5 * 60_000;

interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  totp_secret: string | null;
  totp_pending_secret: string | null;
  totp_enabled: number;
  totp_last_step: number | null;
}

async function adminById(ctx: AppContext, id: number) {
  return ctx.db.first<AdminRow>("SELECT * FROM admins WHERE id = ?", [id]);
}

function currentToken(c: HdContext): string | undefined {
  const auth = c.req.header("authorization");
  const t = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : getCookie(c, SESSION_COOKIE);
  return t && /^[0-9a-f]{64}$/.test(t) ? t : undefined;
}

/** 失敗一次：記錄並回傳要丟出的錯誤（達上限則為 429） */
async function fail(ctx: AppContext, key: string, msg: string, code: string) {
  const r = await recordFailure(ctx, key);
  if (r.locked) return tooMany(r.lockedUntil!);
  const e = unauthorized(msg, code);
  e.details = { remainingAttempts: r.remaining };
  return e;
}

/** 檢查 TOTP（含防重放）；成功時寫回 last_step */
async function checkTotp(ctx: AppContext, admin: AdminRow, code: unknown): Promise<boolean> {
  if (!admin.totp_enabled || !admin.totp_secret) return true;
  const { secret } = await ctx.box.open<{ secret: string }>(admin.totp_secret);
  const step = await verifyTotp(secret, String(code ?? ""), { afterStep: admin.totp_last_step });
  if (step === null) return false;
  await ctx.db.run("UPDATE admins SET totp_last_step = ? WHERE id = ?", [step, admin.id]);
  return true;
}

async function createSession(c: HdContext, admin: AdminRow) {
  const ctx = c.get("ctx");
  const token = randomToken();
  const ttlH = Number(ctx.env.SESSION_TTL_HOURS) || 24 * 7;
  const now = Date.now();
  const expires = now + ttlH * 3600_000;
  await ctx.db.run("DELETE FROM sessions WHERE expires_at < ?", [now]);
  await ctx.db.run("INSERT INTO sessions (token_hash, admin_id, expires_at, created_at, user_agent) VALUES (?, ?, ?, ?, ?)", [
    await sha256Hex(token),
    admin.id,
    expires,
    now,
    c.req.header("user-agent")?.slice(0, 200) ?? null,
  ]);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: ttlH * 3600,
  });
  return c.json({ token, expiresAt: expires, username: admin.username });
}

/**
 * 管理員登入／登出／身分／改密碼／TOTP 兩步驟。session token 以 SHA-256 存放。
 * 速率限制：同一 IP + 帳號連續失敗 5 次鎖定 15 分鐘（密碼或驗證碼錯誤皆計入）。
 */
export const authModule: HdModule = {
  name: "auth",
  routes(app) {
    app.post("/api/auth/login", async (c) => {
      const ctx = c.get("ctx");
      const { username, password, totpCode } = await c.req.json<{ username?: string; password?: string; totpCode?: string }>();
      if (!username || !password) throw badRequest("請輸入帳號與密碼");
      const key = attemptKey(clientIp(c), username);
      await assertNotLocked(ctx, key);
      const admin = await ctx.db.first<AdminRow>("SELECT * FROM admins WHERE username = ?", [username]);
      // 帳號不存在時仍做一次雜湊，避免以回應時間推測帳號
      const ok = await verifyPassword(password, admin?.password_hash ?? DUMMY_HASH);
      if (!admin || !ok) throw await fail(ctx, key, "帳號或密碼錯誤", "invalid_credentials");
      if (admin.totp_enabled) {
        if (totpCode === undefined || totpCode === "") {
          // 第一步通過：發給短效挑戰權杖，第二步帶驗證碼換 session
          const challenge = randomToken();
          const now = Date.now();
          await ctx.db.run("DELETE FROM login_challenges WHERE expires_at < ?", [now]);
          await ctx.db.run("INSERT INTO login_challenges (token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)", [
            await sha256Hex(challenge),
            admin.id,
            now + CHALLENGE_TTL_MS,
            now,
          ]);
          return c.json({ totpRequired: true, challenge, expiresAt: now + CHALLENGE_TTL_MS });
        }
        if (!(await checkTotp(ctx, admin, totpCode))) throw await fail(ctx, key, "驗證碼錯誤", "invalid_totp");
      }
      await clearFailures(ctx, key);
      return createSession(c, admin);
    });

    /** 兩步驟登入第二步：挑戰權杖 + TOTP 驗證碼 */
    app.post("/api/auth/login/totp", async (c) => {
      const ctx = c.get("ctx");
      const { challenge, code } = await c.req.json<{ challenge?: string; code?: string }>();
      if (!challenge || !/^[0-9a-f]{64}$/.test(challenge)) throw badRequest("缺少登入挑戰，請重新輸入帳號密碼");
      const hash = await sha256Hex(challenge);
      const row = await ctx.db.first<{ admin_id: number; expires_at: number }>("SELECT admin_id, expires_at FROM login_challenges WHERE token_hash = ?", [hash]);
      if (!row || row.expires_at < Date.now()) throw unauthorized("登入逾時，請重新輸入帳號密碼", "challenge_expired");
      const admin = await adminById(ctx, row.admin_id);
      if (!admin) throw unauthorized("登入逾時，請重新輸入帳號密碼", "challenge_expired");
      const key = attemptKey(clientIp(c), admin.username);
      await assertNotLocked(ctx, key);
      if (!(await checkTotp(ctx, admin, code))) {
        const e = await fail(ctx, key, "驗證碼錯誤", "invalid_totp");
        if (e.status === 429) await ctx.db.run("DELETE FROM login_challenges WHERE token_hash = ?", [hash]);
        throw e;
      }
      await ctx.db.run("DELETE FROM login_challenges WHERE token_hash = ?", [hash]);
      await clearFailures(ctx, key);
      return createSession(c, admin);
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

    /** 修改密碼：需舊密碼（已啟用 TOTP 時另需驗證碼）；成功後登出其他裝置 */
    app.post("/api/auth/password", async (c) => {
      const me = requireAdmin(c);
      const ctx = c.get("ctx");
      const { oldPassword, newPassword, totpCode } = await c.req.json<{ oldPassword?: string; newPassword?: string; totpCode?: string }>();
      if (!newPassword || newPassword.length < 8) throw badRequest("新密碼至少 8 個字元");
      if (newPassword.length > 256) throw badRequest("新密碼過長");
      if (newPassword === oldPassword) throw badRequest("新密碼不可與舊密碼相同");
      const key = attemptKey(clientIp(c), me.username);
      await assertNotLocked(ctx, key);
      const admin = await adminById(ctx, me.id);
      if (!admin || !(await verifyPassword(oldPassword ?? "", admin.password_hash))) throw await fail(ctx, key, "舊密碼錯誤", "invalid_credentials");
      if (!(await checkTotp(ctx, admin, totpCode))) throw await fail(ctx, key, "驗證碼錯誤", "invalid_totp");
      await clearFailures(ctx, key);
      await ctx.db.run("UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?", [await hashPassword(newPassword), Date.now(), me.id]);
      const cur = currentToken(c);
      await ctx.db.run("DELETE FROM sessions WHERE admin_id = ? AND token_hash != ?", [me.id, cur ? await sha256Hex(cur) : ""]);
      return c.json({ ok: true });
    });

    // ───────── TOTP 兩步驟驗證 ─────────
    app.get("/api/auth/totp", async (c) => {
      const me = requireAdmin(c);
      const a = await adminById(c.get("ctx"), me.id);
      return c.json({ enabled: !!a?.totp_enabled, pending: !!a?.totp_pending_secret && !a?.totp_enabled });
    });

    /** 設定第一步：驗證密碼後產生新秘密（尚未啟用），回傳 otpauth:// 供掃描 */
    app.post("/api/auth/totp/setup", async (c) => {
      const me = requireAdmin(c);
      const ctx = c.get("ctx");
      const { password } = await c.req.json<{ password?: string }>();
      const key = attemptKey(clientIp(c), me.username);
      await assertNotLocked(ctx, key);
      const admin = await adminById(ctx, me.id);
      if (!admin) throw unauthorized();
      if (admin.totp_enabled) throw conflict("兩步驟驗證已啟用，請先停用再重新設定", "totp_already_enabled");
      if (!(await verifyPassword(password ?? "", admin.password_hash))) throw await fail(ctx, key, "密碼錯誤", "invalid_credentials");
      const secret = generateTotpSecret();
      await ctx.db.run("UPDATE admins SET totp_pending_secret = ?, updated_at = ? WHERE id = ?", [await ctx.box.seal({ secret }), Date.now(), me.id]);
      return c.json({ secret, otpauthUrl: otpauthUrl(secret, admin.username) });
    });

    /** 設定第二步：輸入驗證器 App 顯示的驗證碼確認後啟用 */
    app.post("/api/auth/totp/enable", async (c) => {
      const me = requireAdmin(c);
      const ctx = c.get("ctx");
      const { code } = await c.req.json<{ code?: string }>();
      const admin = await adminById(ctx, me.id);
      if (!admin) throw unauthorized();
      if (admin.totp_enabled) throw conflict("兩步驟驗證已啟用", "totp_already_enabled");
      if (!admin.totp_pending_secret) throw badRequest("請先產生兩步驟驗證金鑰", "totp_not_setup");
      const key = attemptKey(clientIp(c), me.username);
      await assertNotLocked(ctx, key);
      const { secret } = await ctx.box.open<{ secret: string }>(admin.totp_pending_secret);
      const step = await verifyTotp(secret, String(code ?? ""));
      if (step === null) throw await fail(ctx, key, "驗證碼錯誤，請確認裝置時間是否正確", "invalid_totp");
      await clearFailures(ctx, key);
      await ctx.db.run(
        "UPDATE admins SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled = 1, totp_last_step = ?, updated_at = ? WHERE id = ?",
        [step, Date.now(), me.id],
      );
      return c.json({ ok: true, enabled: true });
    });

    /** 停用：需密碼與目前驗證碼 */
    app.post("/api/auth/totp/disable", async (c) => {
      const me = requireAdmin(c);
      const ctx = c.get("ctx");
      const { password, code } = await c.req.json<{ password?: string; code?: string }>();
      const admin = await adminById(ctx, me.id);
      if (!admin) throw unauthorized();
      if (!admin.totp_enabled) {
        await ctx.db.run("UPDATE admins SET totp_pending_secret = NULL WHERE id = ?", [me.id]);
        return c.json({ ok: true, enabled: false });
      }
      const key = attemptKey(clientIp(c), me.username);
      await assertNotLocked(ctx, key);
      if (!(await verifyPassword(password ?? "", admin.password_hash))) throw await fail(ctx, key, "密碼錯誤", "invalid_credentials");
      if (!(await checkTotp(ctx, admin, code))) throw await fail(ctx, key, "驗證碼錯誤", "invalid_totp");
      await clearFailures(ctx, key);
      await ctx.db.run(
        "UPDATE admins SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled = 0, totp_last_step = NULL, updated_at = ? WHERE id = ?",
        [Date.now(), me.id],
      );
      return c.json({ ok: true, enabled: false });
    });
  },
};
