import { HttpError } from "../../core/errors";

/**
 * OAuth2 refresh_token → access_token 換取與快取（onedrive / gdrive 共用）。
 * 快取存在驅動實例內（StorageService 依 updated_at 快取驅動實例），提前 60 秒視為過期；
 * 同時進行中的換取會合併為一次請求。供應商若輪替 refresh token，新值僅保留在記憶體中。
 */
export class OAuthTokenCache {
  private token?: string;
  private exp = 0;
  private pending?: Promise<string>;

  constructor(
    private opts: {
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      scope?: string;
      fetch: typeof fetch;
      label: string;
    },
  ) {}

  async get(): Promise<string> {
    if (this.token && Date.now() < this.exp - 60_000) return this.token;
    if (!this.pending) this.pending = this.refresh().finally(() => (this.pending = undefined));
    return this.pending;
  }

  invalidate() {
    this.token = undefined;
    this.exp = 0;
  }

  private async refresh(): Promise<string> {
    const o = this.opts;
    if (!o.refreshToken) throw new HttpError(400, "oauth_required", `${o.label} 尚未授權：請先完成 OAuth 授權取得 refresh token`);
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: o.clientId, client_secret: o.clientSecret, refresh_token: o.refreshToken });
    if (o.scope) body.set("scope", o.scope);
    const r = await o.fetch(o.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new HttpError(502, "upstream_auth", `${o.label} 換取存取權杖失敗：${j.error_description || j.error || `HTTP ${r.status}`}`);
    this.token = j.access_token as string;
    this.exp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
    if (j.refresh_token) o.refreshToken = j.refresh_token;
    return this.token;
  }
}

/** authorization_code → refresh_token（OAuth callback 用） */
export async function exchangeAuthCode(input: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  scope?: string;
  fetch: typeof fetch;
  label: string;
}): Promise<{ refreshToken: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  if (input.scope) body.set("scope", input.scope);
  const r = await input.fetch(input.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, "upstream_auth", `${input.label} 授權失敗：${j.error_description || j.error || `HTTP ${r.status}`}`);
  if (!j.refresh_token) throw new HttpError(502, "upstream_auth", `${input.label} 未回傳 refresh token（請確認已要求離線存取並重新同意授權）`);
  return { refreshToken: j.refresh_token };
}
