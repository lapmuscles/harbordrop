import type { HdModule } from "../types";
import type { AppContext } from "../../core/context";
import { requireAdmin } from "../../core/auth";
import { pruneAnonRate } from "../../core/anonlimit";

export const SUPPORTED_LANGUAGES = ["zh-TW"] as const;

/** 公開站台資訊（GET /api/site）：只含非敏感欄位 */
export interface SiteInfo {
  siteTitle: string;
  announcement: string;
  defaultLanguage: string;
  footer: string;
  allowAnonymousUpload: boolean;
  anonymousMaxBytes: number;
  allowAnonymousPaste: boolean;
  pasteMaxBytes: number;
  anonUploadPerHour: number;
  anonPastePerHour: number;
  fsPublicBrowse: boolean;
}

export async function siteInfo(ctx: AppContext): Promise<SiteInfo> {
  const v = await ctx.settings.all();
  const lang = String(v.defaultLanguage ?? "zh-TW");
  return {
    siteTitle: String(v.siteTitle ?? "HarborDrop"),
    announcement: String(v.siteAnnouncement ?? ""),
    defaultLanguage: (SUPPORTED_LANGUAGES as readonly string[]).includes(lang) ? lang : "zh-TW",
    footer: String(v.siteFooter ?? ""),
    allowAnonymousUpload: !!v.allowAnonymousUpload,
    anonymousMaxBytes: Number(v.anonymousMaxBytes) || 0,
    allowAnonymousPaste: !!v.allowAnonymousPaste,
    pasteMaxBytes: Number(v.pasteMaxBytes) || 0,
    anonUploadPerHour: Number(v.anonUploadPerHour) || 0,
    anonPastePerHour: Number(v.anonPastePerHour) || 0,
    fsPublicBrowse: !!v.fsPublicBrowse,
  };
}

export interface AdminStats {
  shares: number;
  pastes: number;
  storages: number;
  mounts: number;
  totalUploadBytes: number;
  runningTasks: number;
  pendingTasks: number;
  /** 最近 7 天（含今天）每日上傳數，依 tzOffset 分日，由舊到新 */
  dailyUploads: { date: string; count: number; bytes: number }[];
  recentShares: { id: number; slug: string; filename: string; size: number; createdAt: number; expiresAt: number | null; views: number; createdBy: string }[];
}

const DAY_MS = 86_400_000;
const count = async (ctx: AppContext, sql: string, params: unknown[] = []) => Number((await ctx.db.first<{ n: number }>(sql, params))?.n ?? 0);

/**
 * 統計。「上傳」以 shares 表計算（每次完成上傳都會建立分享；upload_sessions 會被過期清理，不適合做歷史統計）。
 * tzOffsetMinutes 與 JS Date#getTimezoneOffset() 相同符號（UTC-4 → 240）。
 */
export async function adminStats(ctx: AppContext, tzOffsetMinutes = 0, now = Date.now()): Promise<AdminStats> {
  const off = Math.max(-840, Math.min(840, Math.trunc(tzOffsetMinutes) || 0)) * 60_000;
  const localNow = now - off;
  const todayStartLocal = Math.floor(localNow / DAY_MS) * DAY_MS;
  const start = todayStartLocal - 6 * DAY_MS + off; // UTC 毫秒
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(todayStartLocal - (6 - i) * DAY_MS);
    return { date: d.toISOString().slice(0, 10), count: 0, bytes: 0 };
  });
  const rows = await ctx.db.all<{ created_at: number; size: number }>("SELECT created_at, size FROM shares WHERE created_at >= ?", [start]);
  for (const r of rows) {
    const i = Math.floor((r.created_at - start) / DAY_MS);
    if (i >= 0 && i < 7) {
      days[i].count++;
      days[i].bytes += Number(r.size) || 0;
    }
  }
  const recent = await ctx.db.all<any>(
    "SELECT id, slug, filename, size, created_at, expires_at, views, created_by FROM shares ORDER BY created_at DESC, id DESC LIMIT 10",
  );
  return {
    shares: await count(ctx, "SELECT COUNT(*) AS n FROM shares"),
    pastes: await count(ctx, "SELECT COUNT(*) AS n FROM pastes"),
    storages: await count(ctx, "SELECT COUNT(*) AS n FROM storages"),
    mounts: await count(ctx, "SELECT COUNT(*) AS n FROM mounts"),
    totalUploadBytes: await count(ctx, "SELECT COALESCE(SUM(size), 0) AS n FROM shares"),
    runningTasks: await count(ctx, "SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'"),
    pendingTasks: await count(ctx, "SELECT COUNT(*) AS n FROM tasks WHERE status = 'pending'"),
    dailyUploads: days,
    recentShares: recent.map((r) => ({
      id: r.id,
      slug: r.slug,
      filename: r.filename,
      size: Number(r.size) || 0,
      createdAt: r.created_at,
      expiresAt: r.expires_at ?? null,
      views: r.views,
      createdBy: r.created_by,
    })),
  };
}

export const siteModule: HdModule = {
  name: "site",
  settings: [
    { key: "siteAnnouncement", default: "", public: true, label: "公告（Markdown，留空不顯示）", input: "textarea" },
    { key: "defaultLanguage", default: "zh-TW", public: true, label: "預設語言", options: [{ value: "zh-TW", label: "繁體中文" }] },
    { key: "siteFooter", default: "", public: true, label: "自訂頁尾（Markdown，留空不顯示）", input: "textarea" },
    { key: "anonUploadPerHour", default: 20, public: true, label: "匿名上傳：每 IP 每小時次數上限（0 = 不限）" },
    { key: "anonPastePerHour", default: 20, public: true, label: "匿名文字分享：每 IP 每小時次數上限（0 = 不限）" },
  ],
  jobs: {
    "site.anonrate.cleanup": async (ctx) => `已清除 ${await pruneAnonRate(ctx)} 筆過期的匿名速率紀錄`,
  },
  async cron(ctx) {
    // 每次喚醒順手清掉舊視窗（單一 DELETE，成本很低）
    await pruneAnonRate(ctx).catch(() => {});
  },
  routes(app) {
    app.get("/api/site", async (c) => {
      c.header("cache-control", "no-store");
      return c.json(await siteInfo(c.get("ctx")));
    });
    app.get("/api/admin/stats", async (c) => {
      requireAdmin(c);
      const tz = Number(c.req.query("tzOffset") ?? 0);
      return c.json(await adminStats(c.get("ctx"), Number.isFinite(tz) ? tz : 0));
    });
  },
};
