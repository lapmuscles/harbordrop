import { afterEach, describe, expect, it, vi } from "vitest";
import { makeApp } from "./helpers/app";
import { createContext } from "../src/core/context";
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from "../src/core/totp";

afterEach(() => vi.useRealTimers());

describe("TOTP（RFC 6238）", () => {
  it("RFC 6238 附錄 B 測試向量（SHA-1、8 位）", async () => {
    const key = new TextEncoder().encode("12345678901234567890");
    const cases: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [t, want] of cases) expect(await hotp(key, Math.floor(t / 30), 8)).toBe(want);
  });
  it("base32 來回、驗證視窗與防重放", async () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251, 252, 9, 8, 7, 6]);
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes));
    expect(base32Encode(new TextEncoder().encode("12345678901234567890"))).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const now = 1_700_000_000_000;
    const code = await totp(secret, now);
    const step = await verifyTotp(secret, code, { now });
    expect(step).toBe(Math.floor(now / 30000));
    expect(await verifyTotp(secret, code, { now: now + 30_000 })).not.toBeNull(); // ±1 步
    expect(await verifyTotp(secret, code, { now: now + 90_000 })).toBeNull();
    expect(await verifyTotp(secret, code, { now, afterStep: step })).toBeNull(); // 重放
    expect(await verifyTotp(secret, "abc", { now })).toBeNull();
  });
});

async function setup(env: Record<string, string> = {}) {
  const h = await makeApp(env);
  const login = (body: any, headers: Record<string, string> = {}) => h.call("POST", "/api/auth/login", body, { "x-real-ip": "1.1.1.1", ...headers });
  return { ...h, loginRaw: login };
}

describe("登入速率限制", () => {
  it("同 IP+帳號失敗 5 次鎖 15 分鐘；其他 IP 不受影響；過期後恢復", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = await setup({ TRUST_PROXY: "true" }); // 測試以 X-Real-IP 模擬不同用戶端，需信任代理標頭
    for (let i = 0; i < 4; i++) {
      const r = await h.loginRaw({ username: "admin", password: "wrong" });
      expect(r.status).toBe(401);
      expect(r.json.error.details.remainingAttempts).toBe(4 - i);
    }
    const fifth = await h.loginRaw({ username: "admin", password: "wrong" });
    expect(fifth.status).toBe(429);
    expect(fifth.json.error.code).toBe("too_many_attempts");
    // 鎖定期間正確密碼也不行
    expect((await h.loginRaw({ username: "admin", password: "pass-1234" })).status).toBe(429);
    // 其他 IP 可登入
    expect((await h.loginRaw({ username: "admin", password: "pass-1234" }, { "x-real-ip": "2.2.2.2" })).status).toBe(200);
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1000);
    const ok = await h.loginRaw({ username: "admin", password: "pass-1234" });
    expect(ok.status).toBe(200);
    expect((await h.ctx.db.first<any>("SELECT COUNT(*) AS n FROM login_attempts WHERE key = '1.1.1.1|admin'"))!.n).toBe(0);
  });
  it("不存在的帳號也計數（不洩漏帳號是否存在）", async () => {
    const h = await setup();
    for (let i = 0; i < 5; i++) await h.loginRaw({ username: "ghost", password: "x" });
    expect((await h.loginRaw({ username: "ghost", password: "x" })).status).toBe(429);
    expect((await h.loginRaw({ username: "admin", password: "pass-1234" })).status).toBe(200);
  });
});

describe("TOTP 兩步驟登入", () => {
  async function enableTotp(h: Awaited<ReturnType<typeof setup>>) {
    const token = (await h.loginRaw({ username: "admin", password: "pass-1234" })).json.token;
    const auth = { authorization: `Bearer ${token}` };
    expect((await h.call("POST", "/api/auth/totp/setup", { password: "bad" }, auth)).status).toBe(401);
    const s = await h.call("POST", "/api/auth/totp/setup", { password: "pass-1234" }, auth);
    expect(s.json.otpauthUrl).toMatch(/^otpauth:\/\/totp\/HarborDrop%3Aadmin\?secret=[A-Z2-7]+/);
    expect((await h.call("GET", "/api/auth/totp", undefined, auth)).json).toEqual({ enabled: false, pending: true });
    expect((await h.call("POST", "/api/auth/totp/enable", { code: "000000" }, auth)).status).toBe(401);
    const en = await h.call("POST", "/api/auth/totp/enable", { code: await totp(s.json.secret) }, auth);
    expect(en.json).toEqual({ ok: true, enabled: true });
    const raw = await h.ctx.db.first<any>("SELECT totp_secret FROM admins");
    expect(raw.totp_secret).not.toContain(s.json.secret);
    return { secret: s.json.secret as string, auth };
  }

  it("設定→啟用→兩步驟登入→停用", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = await setup();
    const { secret, auth } = await enableTotp(h);
    vi.setSystemTime(Date.now() + 60_000); // 避開啟用時用過的時間步
    const step1 = await h.loginRaw({ username: "admin", password: "pass-1234" });
    expect(step1.json.totpRequired).toBe(true);
    expect(step1.json.token).toBeUndefined();
    const bad = await h.call("POST", "/api/auth/login/totp", { challenge: step1.json.challenge, code: "123456" }, { "x-real-ip": "1.1.1.1" });
    expect(bad.status).toBe(401);
    const code = await totp(secret);
    const ok = await h.call("POST", "/api/auth/login/totp", { challenge: step1.json.challenge, code }, { "x-real-ip": "1.1.1.1" });
    expect(ok.status).toBe(200);
    expect(ok.json.token).toMatch(/^[0-9a-f]{64}$/);
    // 挑戰只能用一次；同一驗證碼不能重放
    expect((await h.call("POST", "/api/auth/login/totp", { challenge: step1.json.challenge, code })).status).toBe(401);
    expect((await h.loginRaw({ username: "admin", password: "pass-1234", totpCode: code })).status).toBe(401);
    // 單步：帳密 + 驗證碼
    vi.setSystemTime(Date.now() + 60_000);
    expect((await h.loginRaw({ username: "admin", password: "pass-1234", totpCode: await totp(secret) })).status).toBe(200);
    // 停用需密碼與驗證碼
    vi.setSystemTime(Date.now() + 60_000);
    expect((await h.call("POST", "/api/auth/totp/disable", { password: "pass-1234", code: "000000" }, auth)).status).toBe(401);
    expect((await h.call("POST", "/api/auth/totp/disable", { password: "pass-1234", code: await totp(secret) }, auth)).json.enabled).toBe(false);
    expect((await h.loginRaw({ username: "admin", password: "pass-1234" })).json.token).toBeTruthy();
  });

  it("驗證碼錯誤也計入鎖定；ADMIN_RESET 會關閉 TOTP", async () => {
    const h = await setup();
    await enableTotp(h);
    for (let i = 0; i < 4; i++) expect((await h.loginRaw({ username: "admin", password: "pass-1234", totpCode: "000000" })).status).toBe(401);
    expect((await h.loginRaw({ username: "admin", password: "pass-1234", totpCode: "000000" })).status).toBe(429);
    await createContext(h.ctx.db, { ...h.ctx.env, ADMIN_PASSWORD: "reset-pass-1", ADMIN_RESET: "1" }, "node");
    const a = await h.ctx.db.first<any>("SELECT totp_enabled, totp_secret FROM admins");
    expect(a).toEqual({ totp_enabled: 0, totp_secret: null });
  });
});

describe("修改密碼", () => {
  it("需舊密碼、登出其他裝置、保留目前 session", async () => {
    const h = await setup();
    const t1 = (await h.loginRaw({ username: "admin", password: "pass-1234" })).json.token;
    const t2 = (await h.loginRaw({ username: "admin", password: "pass-1234" })).json.token;
    const a1 = { authorization: `Bearer ${t1}`, "x-real-ip": "1.1.1.1" };
    expect((await h.call("POST", "/api/auth/password", { oldPassword: "x", newPassword: "new-pass-99" }, a1)).status).toBe(401);
    expect((await h.call("POST", "/api/auth/password", { oldPassword: "pass-1234", newPassword: "short" }, a1)).status).toBe(400);
    expect((await h.call("POST", "/api/auth/password", { oldPassword: "pass-1234", newPassword: "new-pass-99" }, a1)).status).toBe(200);
    expect((await h.call("GET", "/api/auth/me", undefined, a1)).json.kind).toBe("admin");
    expect((await h.call("GET", "/api/auth/me", undefined, { authorization: `Bearer ${t2}` })).json.kind).toBe("anon");
    expect((await h.loginRaw({ username: "admin", password: "pass-1234" })).status).toBe(401);
    expect((await h.loginRaw({ username: "admin", password: "new-pass-99" })).status).toBe(200);
  });
});
