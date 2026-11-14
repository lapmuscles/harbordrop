import { reactive } from "vue";
import { HdClient } from "@harbordrop/shared/upload";
import type { Me, PublicConfig } from "@harbordrop/shared";

/** 同源 API 客戶端（管理員以 HttpOnly cookie 驗證） */
export const api = new HdClient({ baseUrl: location.origin });

/** GET /api/site 的公開站台資訊（feat/site） */
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

export const session = reactive<{ me: Me | null; config: PublicConfig | null; site: SiteInfo | null }>({ me: null, config: null, site: null });

export async function refreshSession() {
  const [me, config, site] = await Promise.all([
    api.json<Me>("GET", "/api/auth/me"),
    api.json<PublicConfig>("GET", "/api/public/config"),
    api.json<SiteInfo>("GET", "/api/site").catch(() => null),
  ]);
  session.me = me;
  session.config = config;
  session.site = site;
}
