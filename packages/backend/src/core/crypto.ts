/** 僅使用 WebCrypto，Workers 與 Node 20+ 皆可執行 */
const enc = new TextEncoder();
const dec = new TextDecoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** 不含易混淆字元的隨機字串（slug、ID 用） */
export function randomId(len = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const x of bytes) s += ALPHABET[x % ALPHABET.length];
  return s;
}
export function randomToken(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Workers 的 PBKDF2 上限為 100000 次
const PBKDF2_ITER = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: iter }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$sha256$${PBKDF2_ITER}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [scheme, algo, iterS, saltS, hashS] = stored.split("$");
  if (scheme !== "pbkdf2" || algo !== "sha256") return false;
  const hash = await pbkdf2(password, unb64(saltS), Number(iterS));
  return timingSafeEqual(b64(hash), hashS);
}

/** 機密欄位加密：AES-256-GCM，金鑰 = SHA-256(APP_SECRET) */
export class SecretBox {
  private keyP: Promise<CryptoKey>;
  constructor(appSecret: string) {
    if (!appSecret || appSecret.length < 16) throw new Error("APP_SECRET 未設定或長度不足 16 字元");
    this.keyP = crypto.subtle
      .digest("SHA-256", enc.encode(appSecret))
      .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  }
  async seal(obj: unknown): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.keyP, enc.encode(JSON.stringify(obj)));
    return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
  }
  async open<T = Record<string, unknown>>(sealed: string | null | undefined): Promise<T> {
    if (!sealed) return {} as T;
    const [v, ivS, ctS] = sealed.split(".");
    if (v !== "v1") throw new Error("無法辨識的加密格式");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivS) as BufferSource }, await this.keyP, unb64(ctS) as BufferSource);
    return JSON.parse(dec.decode(pt));
  }
}
