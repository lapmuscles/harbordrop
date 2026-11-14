import { badRequest, HttpError } from "../../../core/errors";
import { RelayDriver, relayHttpError, type ChunkRef, type RelayBackend } from "../../relay";
import type { DriverContext, DriverDefinition } from "../../types";

export interface DiscordConfig {
  webhookUrl?: string;
  botToken?: string;
  channelId?: string;
  chunkSizeMB?: number;
  apiBase?: string;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  attachments: { id: string; filename: string; size: number; url: string }[];
}

/**
 * Discord：每片作為一則訊息的附件。可用 Webhook（只需 URL）或 Bot Token + 頻道 ID。
 * 附件 CDN 網址會過期，取回失敗時重新讀取訊息拿新網址。
 */
export class DiscordBackend implements RelayBackend {
  readonly type = "discord";
  readonly chunkSize: number;
  private api: string;
  private mode: "webhook" | "bot";
  private webhook = "";

  constructor(
    private cfg: DiscordConfig,
    private f: typeof fetch,
  ) {
    this.api = (cfg.apiBase || "https://discord.com/api/v10").replace(/\/+$/, "");
    if (cfg.webhookUrl) {
      let u: URL;
      try {
        u = new URL(cfg.webhookUrl);
      } catch {
        throw badRequest("Webhook URL 格式錯誤");
      }
      if (!/\/webhooks\/\d+\/[^/]+/.test(u.pathname)) throw badRequest("Webhook URL 格式錯誤（應為 …/api/webhooks/<id>/<token>）");
      u.search = "";
      this.webhook = u.href.replace(/\/+$/, "");
      this.mode = "webhook";
    } else if (cfg.botToken && cfg.channelId) this.mode = "bot";
    else throw badRequest("請填寫 Webhook URL，或同時填寫 Bot Token 與頻道 ID");
    const mb = Number(cfg.chunkSizeMB) || 8;
    this.chunkSize = Math.max(256 * 1024, Math.floor(mb * 1024 * 1024));
  }

  private messagesUrl(id?: string) {
    if (this.mode === "webhook") return id ? `${this.webhook}/messages/${id}` : `${this.webhook}?wait=true`;
    return `${this.api}/channels/${this.cfg.channelId}/messages${id ? `/${id}` : ""}`;
  }
  private auth(): Record<string, string> {
    return this.mode === "bot" ? { Authorization: `Bot ${this.cfg.botToken}` } : {};
  }

  private async req(url: string, init: RequestInit, label: string): Promise<Response> {
    let r: Response;
    try {
      r = await this.f(url, { ...init, headers: { ...this.auth(), ...((init.headers as Record<string, string>) ?? {}) } });
    } catch (e: any) {
      throw new HttpError(503, "relay_error", `Discord ${label}失敗：${e?.message ?? e}`);
    }
    if (!r.ok) throw await relayHttpError(`Discord ${label}`, r);
    return r;
  }

  async testConnection() {
    try {
      const url = this.mode === "webhook" ? this.webhook : `${this.api}/channels/${this.cfg.channelId}`;
      const j = (await (await this.req(url, { method: "GET" }, "連線測試")).json()) as { name?: string };
      return { ok: true, message: `已連線（${this.mode === "webhook" ? "Webhook" : "Bot"}）：${j.name ?? ""}`.trim() };
    } catch (e: any) {
      return { ok: false, message: String(e?.message ?? e) };
    }
  }

  async uploadChunk(name: string, data: Uint8Array): Promise<ChunkRef> {
    const fd = new FormData();
    fd.set("payload_json", JSON.stringify({ content: "", attachments: [{ id: 0, filename: name }] }));
    fd.set("files[0]", new Blob([data as BlobPart], { type: "application/octet-stream" }), name);
    const r = await this.req(this.messagesUrl(), { method: "POST", body: fd }, "上傳分片");
    const msg = (await r.json()) as DiscordMessage;
    const att = msg.attachments?.[0];
    if (!att) throw new HttpError(502, "relay_error", "Discord 未回傳附件");
    return { messageId: msg.id, channelId: msg.channel_id, attachmentId: att.id, url: att.url };
  }

  private async freshUrl(ref: ChunkRef): Promise<string> {
    const r = await this.req(this.messagesUrl(String(ref.messageId)), { method: "GET" }, "讀取分片訊息");
    const msg = (await r.json()) as DiscordMessage;
    const att = msg.attachments.find((a) => a.id === ref.attachmentId) ?? msg.attachments[0];
    if (!att) throw new HttpError(502, "relay_error", "Discord 訊息中找不到分片附件");
    return att.url;
  }

  async fetchChunk(ref: ChunkRef, range?: { start: number; end: number }): Promise<Response> {
    const headers: Record<string, string> = range ? { Range: `bytes=${range.start}-${range.end}` } : {};
    if (typeof ref.url === "string") {
      const r = await this.f(ref.url, { headers }).catch(() => null);
      if (r?.ok) return r;
      await r?.body?.cancel().catch(() => {});
    }
    return this.f(await this.freshUrl(ref), { headers });
  }

  async deleteChunk(ref: ChunkRef): Promise<void> {
    const r = await this.f(this.messagesUrl(String(ref.messageId)), { method: "DELETE", headers: this.auth() });
    if (!r.ok && r.status !== 404) throw await relayHttpError("Discord 刪除分片", r);
  }
}

export const discordDriver: DriverDefinition = {
  type: "discord",
  label: "Discord",
  description: "把檔案分片（預設每片 8MB）作為附件存到 Discord 頻道；可用 Webhook 或 Bot。檔案清單存在資料庫。",
  fields: [
    { key: "webhookUrl", label: "Webhook URL", type: "secret", placeholder: "https://discord.com/api/webhooks/…", help: "填寫 Webhook 就不需要 Bot Token" },
    { key: "botToken", label: "Bot Token", type: "secret", help: "不使用 Webhook 時填寫；Bot 需有傳送訊息、附加檔案、讀取訊息紀錄、管理訊息權限" },
    { key: "channelId", label: "頻道 ID", type: "string", help: "使用 Bot Token 時必填" },
    { key: "chunkSizeMB", label: "分片大小（MB）", type: "number", default: 8, help: "一般伺服器附件上限 10MB；Nitro／加成伺服器可調高" },
    { key: "apiBase", label: "API 位址", type: "string", default: "https://discord.com/api/v10" },
  ],
  create(config, ctx: DriverContext) {
    return new RelayDriver(new DiscordBackend(config as DiscordConfig, ctx.fetch), ctx);
  },
};
