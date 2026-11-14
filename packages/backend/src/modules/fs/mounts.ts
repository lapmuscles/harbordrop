import type { AppContext } from "../../core/context";
import { badRequest } from "../../core/errors";
import { joinPath, normalizePath } from "../../storage/util";

/**
 * 掛載解析（webdav／search 可 import 本檔）：
 * 虛擬路徑 /<mount_path>/<rest> → storage_id + joinPath(root_path, rest)。
 * 取「最長」相符的掛載點；沒有掛載但為掛載點祖先的路徑是虛擬目錄（例如 / 列出所有掛載點）。
 */

export interface MountRow {
  id: number;
  mount_path: string;
  storage_id: number;
  root_path: string;
  readonly: number;
  enabled: number;
  web_proxy: number;
  cache_ttl: number;
  sort: number;
  options: string;
  created_at: number;
  updated_at: number;
}

export interface Resolved {
  mount: MountRow;
  storageId: number;
  /** 儲存內相對路徑（驅動用） */
  rel: string;
  /** 掛載點內的剩餘路徑 */
  rest: string;
  vpath: string;
}

export function vnorm(p: unknown): string {
  try {
    return normalizePath(String(p ?? "/"));
  } catch {
    throw badRequest("路徑不正確", "invalid_path");
  }
}

export async function loadMounts(ctx: AppContext, includeDisabled = false): Promise<MountRow[]> {
  return ctx.db.all<MountRow>(`SELECT * FROM mounts ${includeDisabled ? "" : "WHERE enabled = 1"} ORDER BY sort, mount_path`);
}

const under = (p: string, base: string) => base === "/" || p === base || p.startsWith(base + "/");

export function resolveIn(mounts: MountRow[], vpath: string): Resolved | null {
  let best: MountRow | null = null;
  for (const m of mounts) if (under(vpath, m.mount_path) && (!best || m.mount_path.length > best.mount_path.length)) best = m;
  if (!best) return null;
  const rest = best.mount_path === "/" ? vpath : vpath.slice(best.mount_path.length) || "/";
  return { mount: best, storageId: best.storage_id, rel: joinPath(best.root_path, rest), rest: normalizePath(rest), vpath };
}

/** vpath 底下（不含自身）的掛載點，在下一層顯示成的目錄名稱 */
export function virtualChildren(mounts: MountRow[], vpath: string): string[] {
  const names = new Set<string>();
  for (const m of mounts) {
    if (m.mount_path === vpath || !under(m.mount_path, vpath)) continue;
    const tail = vpath === "/" ? m.mount_path.slice(1) : m.mount_path.slice(vpath.length + 1);
    const seg = tail.split("/")[0];
    if (seg) names.add(seg);
  }
  return [...names];
}

export async function resolvePath(ctx: AppContext, vpath: string): Promise<Resolved | null> {
  return resolveIn(await loadMounts(ctx), vnorm(vpath));
}

export const basename = (p: string) => p.split("/").pop() || "";
export const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
