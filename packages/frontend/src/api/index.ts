import { reactive } from "vue";
import { HdClient } from "@harbordrop/shared/upload";
import type { Me, PublicConfig } from "@harbordrop/shared";

/** 同源 API 客戶端（管理員以 HttpOnly cookie 驗證） */
export const api = new HdClient({ baseUrl: location.origin });

export const session = reactive<{ me: Me | null; config: PublicConfig | null }>({ me: null, config: null });

export async function refreshSession() {
  const [me, config] = await Promise.all([api.json<Me>("GET", "/api/auth/me"), api.json<PublicConfig>("GET", "/api/public/config")]);
  session.me = me;
  session.config = config;
}
