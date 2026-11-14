import type { AppContext, HdContext } from "../../core/context";
import { HttpError } from "../../core/errors";
import { signToken, verifyToken } from "../../core/sign";
import { normalizePath } from "../../storage/util";

/**
 * 目錄 meta（隱藏規則、目錄密碼、header/readme）。
 * 生效規則：每個屬性各自取「最接近的」有設定該屬性的 meta——自身路徑一定生效，
 * 祖先路徑則需 apply_to_children = 1。fs 模組與 webdav 可 import 本檔。
 */

export interface FsMetaRow {
  id: number;
  path: string;
  header_md: string | null;
  readme_md: string | null;
  password_hash: string | null;
  hide_patterns: string;
  apply_to_children: number;
  created_at: number;
  updated_at: number;
}

export interface EffectiveMeta {
  headerMd: string | null;
  readmeMd: string | null;
  hidePatterns: string[];
  /** 生效中的密碼設定所在路徑（null = 不需密碼） */
  passwordPath: string | null;
  passwordHash: string | null;
}

export const UNLOCK_TTL_SECONDS = 24 * 3600;
export const unlockPurpose = (metaPath: string) => `fsmeta:${metaPath}`;

/** 路徑本身與所有祖先（由近到遠） */
export function ancestors(vpath: string): string[] {
  const p = normalizePath(vpath);
  const out = [p];
  let cur = p;
  while (cur !== "/") {
    cur = cur.slice(0, cur.lastIndexOf("/")) || "/";
    out.push(cur);
  }
  return out;
}

export async function effectiveMeta(ctx: AppContext, vpath: string): Promise<EffectiveMeta> {
  const chain = ancestors(vpath);
  const rows = await ctx.db.all<FsMetaRow>(`SELECT * FROM fs_meta WHERE path IN (${chain.map(() => "?").join(",")})`, chain);
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const applicable = chain.map((p, i) => byPath.get(p)).filter((r, i): r is FsMetaRow => !!r && (r.path === chain[0] || !!r.apply_to_children));
  const pick = <T>(f: (r: FsMetaRow) => T | null | undefined): [T | null, FsMetaRow | null] => {
    for (const r of applicable) {
      const v = f(r);
      if (v !== null && v !== undefined) return [v, r];
    }
    return [null, null];
  };
  const [hide] = pick((r) => {
    const a = JSON.parse(r.hide_patterns || "[]") as string[];
    return a.length ? a : null;
  });
  const [pw, pwRow] = pick((r) => r.password_hash || null);
  return {
    headerMd: pick((r) => r.header_md || null)[0],
    readmeMd: pick((r) => r.readme_md || null)[0],
    hidePatterns: hide ?? [],
    passwordPath: pwRow?.path ?? null,
    passwordHash: pw,
  };
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** 名稱是否被隱藏。含 / 的規則比對完整虛擬路徑，否則比對名稱 */
export function isHidden(name: string, fullPath: string, patterns: string[]): boolean {
  return patterns.some((g) => (g.includes("/") ? globToRegExp(normalizePath(g)).test(fullPath) : globToRegExp(g).test(name)));
}

/** 讀取請求帶來的解鎖權杖：X-Fs-Token（可逗號分隔多個）或 ?fsToken= */
export function requestTokens(c: HdContext): string[] {
  const h = c.req.header("x-fs-token") ?? "";
  const q = c.req.query("fsToken") ?? "";
  return [...h.split(","), ...q.split(",")].map((s) => s.trim()).filter(Boolean);
}

export async function issueUnlockToken(ctx: AppContext, metaPath: string): Promise<string> {
  return signToken(ctx.env.APP_SECRET ?? "", unlockPurpose(metaPath), UNLOCK_TTL_SECONDS);
}

/** 檢查密碼保護。管理員略過。未解鎖時丟 403 password_required（details.path 為需解鎖的路徑） */
export async function assertUnlocked(c: HdContext, meta: EffectiveMeta): Promise<void> {
  if (!meta.passwordPath) return;
  if (c.get("principal").kind === "admin") return;
  const ctx = c.get("ctx");
  for (const t of requestTokens(c)) {
    if (await verifyToken(ctx.env.APP_SECRET ?? "", unlockPurpose(meta.passwordPath), t)) return;
  }
  throw new HttpError(403, "password_required", "此目錄需要密碼", { path: meta.passwordPath });
}

/** 由已載入的 meta 列計算某目錄生效的隱藏規則（與 effectiveMeta 相同的就近規則） */
function hidePatternsFor(dir: string, byPath: Map<string, FsMetaRow>): string[] {
  const chain = ancestors(dir);
  for (const p of chain) {
    const r = byPath.get(p);
    if (!r || (p !== chain[0] && !r.apply_to_children)) continue;
    const a = JSON.parse(r.hide_patterns || "[]") as string[];
    if (a.length) return a;
  }
  return [];
}

/**
 * 路徑本身或任何祖先是否被隱藏：對每一層 a（不含 /）檢查 a 的名稱是否命中 dirname(a) 生效的隱藏規則。
 * 例如 /pub 隱藏 secret 時，/pub/secret/x.txt 也一律視為隱藏（list／get／download 都要擋）。
 * 只查一次資料庫。
 */
export async function isHiddenPath(ctx: AppContext, vpath: string): Promise<boolean> {
  const chain = ancestors(vpath);
  if (chain.length <= 1) return false;
  const rows = await ctx.db.all<FsMetaRow>(`SELECT * FROM fs_meta WHERE path IN (${chain.map(() => "?").join(",")})`, chain);
  if (!rows.length) return false;
  const byPath = new Map(rows.map((r) => [r.path, r]));
  for (const a of chain) {
    if (a === "/") continue;
    const parent = a.slice(0, a.lastIndexOf("/")) || "/";
    const name = a.slice(a.lastIndexOf("/") + 1);
    if (isHidden(name, a, hidePatternsFor(parent, byPath))) return true;
  }
  return false;
}
