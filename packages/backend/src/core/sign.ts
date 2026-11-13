import { toHex, timingSafeEqual } from "./crypto";

const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string) {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keys.set(secret, k);
  }
  return k;
}

/** 簽發短效權杖：<exp>.<hmac>，用於分享密碼解鎖等 */
export async function signToken(secret: string, purpose: string, ttlSeconds: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = toHex(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${purpose}|${exp}`)));
  return `${exp}.${sig}`;
}

export async function verifyToken(secret: string, purpose: string, token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const [expS, sig] = token.split(".");
  const exp = Number(expS);
  if (!exp || exp < Date.now() / 1000 || !sig) return false;
  const want = toHex(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(`${purpose}|${exp}`)));
  return timingSafeEqual(want, sig);
}
