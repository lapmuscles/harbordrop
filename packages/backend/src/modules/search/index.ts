import type { HdModule } from "../types";
import type { AppContext } from "../../core/context";
import { can, principalId, requireAdmin } from "../../core/auth";
import { badRequest, forbidden, unauthorized } from "../../core/errors";
import { guessMime } from "../../storage/util";
import { effectiveMeta, isHidden, type EffectiveMeta } from "../fsmeta/service";
import { registerTaskHandler } from "../tasks/service";
import { basename, dirname, loadMounts, resolveIn, vnorm } from "../fs/mounts";
import { ensureFts, queryIndex, REINDEX_KIND, runReindexStep, startReindex } from "./service";

/**
 * 搜尋（規格：docs/MODULES-zhTW.md#search）
 *   GET  /api/search?q=&mount=&limit=      mount = 掛載路徑（如 /a）或掛載 ID；結果套用 fsmeta 隱藏／密碼與 can(fs.read)
 *   GET  /api/admin/search/status          索引筆數與 tokenizer
 *   POST /api/admin/search/reindex {mountId?}  建立 tasks 工作（kind=search.reindex，BFS 分段、db.batch 寫入）
 *   jobs: search.reindex（排程；已有進行中的重建工作時略過）
 */

registerTaskHandler(REINDEX_KIND, runReindexStep);

async function activeReindex(ctx: AppContext) {
  return ctx.db.first<{ id: string }>("SELECT id FROM tasks WHERE kind = ? AND status IN ('pending', 'running') LIMIT 1", [REINDEX_KIND]);
}

export const searchModule: HdModule = {
  name: "search",
  routes(app) {
    app.get("/api/search", async (c) => {
      const ctx = c.get("ctx");
      const p = c.get("principal");
      if (p.kind === "anon" && !(await ctx.settings.get("fsPublicBrowse"))) throw unauthorized("未開放匿名瀏覽，請先登入");
      if (p.kind === "apikey" && !can(p, "fs.read")) throw forbidden("沒有搜尋權限（需要 fs.read）");
      const q = (c.req.query("q") ?? "").trim();
      if (!q) throw badRequest("請輸入搜尋關鍵字", "empty_query");
      if (q.length > 100) throw badRequest("搜尋關鍵字過長（上限 100 字）");
      const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
      const mounts = await loadMounts(ctx);
      let prefix: string | undefined;
      const mq = c.req.query("mount");
      if (mq) {
        const byId = /^\d+$/.test(mq) ? mounts.find((m) => m.id === Number(mq)) : undefined;
        prefix = byId ? byId.mount_path : vnorm(mq);
      }
      const rows = await queryIndex(ctx, q, { prefix, limit: limit * 4 });
      const metaCache = new Map<string, EffectiveMeta>();
      const meta = async (v: string) => {
        let m = metaCache.get(v);
        if (!m) metaCache.set(v, (m = await effectiveMeta(ctx, v)));
        return m;
      };
      const results = [];
      for (const r of rows) {
        if (results.length >= limit) break;
        const res = resolveIn(mounts, r.vpath);
        if (!res || res.mount.id !== r.mount_id) continue; // 掛載已變更：等下次重建
        if (p.kind !== "admin") {
          if (p.kind === "apikey" && !can(p, "fs.read", { storageId: res.storageId, mountId: res.mount.id, path: r.vpath })) continue;
          // 任一祖先被隱藏或需密碼 → 不顯示
          let blocked = false;
          for (let v = r.vpath; v !== "/"; v = dirname(v)) {
            const parent = await meta(dirname(v));
            if (isHidden(basename(v), v, parent.hidePatterns) || parent.passwordPath) {
              blocked = true;
              break;
            }
          }
          if (blocked || (await meta(r.vpath)).passwordPath) continue;
        }
        results.push({
          name: r.name,
          path: r.vpath,
          isDir: !!r.is_dir,
          size: r.size,
          modifiedAt: r.modified_at,
          mime: r.is_dir ? null : guessMime(r.name),
          mountId: r.mount_id,
        });
      }
      return c.json({ query: q, results, tokenizer: await ensureFts(ctx) });
    });

    app.get("/api/admin/search/status", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const tokenizer = await ensureFts(ctx);
      const n = await ctx.db.first<{ n: number; last: number | null }>("SELECT COUNT(*) AS n, MAX(indexed_at) AS last FROM search_index");
      const active = await activeReindex(ctx);
      return c.json({ tokenizer, entries: n?.n ?? 0, lastIndexedAt: n?.last ?? null, activeTaskId: active?.id ?? null });
    });

    app.post("/api/admin/search/reindex", async (c) => {
      const p = requireAdmin(c);
      const ctx = c.get("ctx");
      const b = await c.req.json<{ mountId?: number }>().catch(() => ({}) as { mountId?: number });
      const mountId = b.mountId === undefined || b.mountId === null ? undefined : Number(b.mountId);
      if (mountId !== undefined && !(await loadMounts(ctx, true)).some((m) => m.id === mountId)) throw badRequest("找不到此掛載");
      const taskId = await startReindex(ctx, { mountId, createdBy: principalId(p) });
      return c.json({ taskId }, 202);
    });
  },
  jobs: {
    async [REINDEX_KIND](ctx, config) {
      const active = await activeReindex(ctx);
      if (active) return `已有進行中的重建索引工作（${active.id}），本次略過`;
      const mountId = config?.mountId === undefined ? undefined : Number(config.mountId);
      const id = await startReindex(ctx, { mountId, createdBy: "job" });
      return `已建立重建索引工作 ${id}`;
    },
  },
};
