/** TOTP（RFC 6238，HMAC-SHA1，30 秒，6 位數）。僅用 WebCrypto，Workers 與 Node 皆可用 */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("base32 格式錯誤");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** 產生 160-bit 隨機秘密（base32） */
export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export async function hotp(key: Uint8Array, counter: number, digits = 6, hash: "SHA-1" | "SHA-256" | "SHA-512" = "SHA-1"): Promise<string> {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const TOTP_STEP = 30;

export function totpStep(nowMs = Date.now(), step = TOTP_STEP): number {
  return Math.floor(nowMs / 1000 / step);
}

export async function totp(secretB32: string, nowMs = Date.now(), digits = 6): Promise<string> {
  return hotp(base32Decode(secretB32), totpStep(nowMs), digits);
}

/**
 * 驗證 TOTP；允許前後 window 個時間步（預設 ±1，即 ±30 秒）。
 * 成功回傳符合的時間步（供防重放：只接受大於上次成功的時間步），失敗回傳 null。
 */
export async function verifyTotp(secretB32: string, code: string, opts: { now?: number; window?: number; afterStep?: number | null } = {}): Promise<number | null> {
  const c = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretB32);
  const cur = totpStep(opts.now ?? Date.now());
  const w = opts.window ?? 1;
  let matched: number | null = null;
  for (let s = cur - w; s <= cur + w; s++) {
    // 逐一比較，不提早結束（降低時間差洩漏）
    const ok = (await hotp(key, s)) === c;
    if (ok && matched === null && (opts.afterStep == null || s > opts.afterStep)) matched = s;
  }
  return matched;
}

export function otpauthUrl(secretB32: string, account: string, issuer = "HarborDrop"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
