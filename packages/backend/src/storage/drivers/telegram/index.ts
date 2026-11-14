import { badRequest, HttpError } from "../../../core/errors";
import { RelayDriver, relayHttpError, type ChunkRef, type RelayBackend } from "../../relay";
import type { DriverContext, DriverDefinition } from "../../types";

/** Bot API getFile 只能下載 ≤20MB 的檔案，因此每片上限 20MB */
export const TELEGRAM_MAX_CHUNK = 20 * 1000 * 1000;

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  apiBase?: string;
  chunkSizeMB?: number;
}

/**
 * Telegram：每片以 sendDocument 傳到指定聊天（頻道／群組／私訊），
 * 下載時 getFile 取得 file_path 再串流取回（支援 Range）。
 */
export class TelegramBackend implements RelayBackend {
  readonly type = "telegram";
  readonly chunkSize: number;
  private api: string;

  constructor(
    private cfg: TelegramConfig,
    private f: typeof fetch,
  ) {
    if (!cfg.botToken) throw badRequest("請填寫「Bot Token」");
    if (!cfg.chatId) throw badRequest("請填寫「Chat ID」");
    this.api = (cfg.apiBase || "https://api.telegram.org").replace(/\/+$/, "");
    const mb = Number(cfg.chunkSizeMB) || 20;
    this.chunkSize = Math.max(1024 * 1024, Math.min(TELEGRAM_MAX_CHUNK, Math.floor(mb * 1000 * 1000)));
  }

  private url(method: string) {
    return `${this.api}/bot${this.cfg.botToken}/${method}`;
  }

  private async call<T = any>(method: string, body: Record<string, unknown> | FormData, label: string): Promise<T> {
    const init: RequestInit =
      body instanceof FormData ? { method: "POST", body } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    let r: Response;
    try {
      r = await this.f(this.url(method), init);
    } catch (e: any) {
      throw new HttpError(503, "relay_error", `${label}失敗：${e?.message ?? e}`);
    }
    if (!r.ok) throw await relayHttpError(`Telegram ${label}`, r);
    const j = (await r.json()) as { ok: boolean; result: T; description?: string };
    if (!j.ok) throw new HttpError(502, "relay_error", `Telegram ${label}失敗：${j.description ?? "未知錯誤"}`);
    return j.result;
  }

  async testConnection() {
    try {
      const me = await this.call<{ username: string }>("getMe", {}, "驗證 Bot");
      const chat = await this.call<{ title?: string; username?: string; type: string }>("getChat", { chat_id: this.cfg.chatId }, "讀取聊天");
      return { ok: true, message: `已連線：@${me.username} → ${chat.title ?? chat.username ?? chat.type}` };
    } catch (e: any) {
      return { ok: false, message: String(e?.message ?? e) };
    }
  }

  async uploadChunk(name: string, data: Uint8Array): Promise<ChunkRef> {
    const fd = new FormData();
    fd.set("chat_id", this.cfg.chatId);
    fd.set("disable_notification", "true");
    fd.set("disable_content_type_detection", "true");
    fd.set("document", new Blob([data as BlobPart], { type: "application/octet-stream" }), name);
    const msg = await this.call<{ message_id: number; document?: { file_id: string; file_unique_id: string; file_size?: number } }>("sendDocument", fd, "上傳分片");
    if (!msg.document?.file_id) throw new HttpError(502, "relay_error", "Telegram 未回傳 file_id");
    return { fileId: msg.document.file_id, uniqueId: msg.document.file_unique_id, messageId: msg.message_id };
  }

  async fetchChunk(ref: ChunkRef, range?: { start: number; end: number }): Promise<Response> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: ref.fileId }, "取得檔案");
    if (!file.file_path) throw new HttpError(502, "relay_error", "Telegram 未回傳 file_path（檔案可能超過 20MB）");
    const headers: Record<string, string> = range ? { Range: `bytes=${range.start}-${range.end}` } : {};
    return this.f(`${this.api}/file/bot${this.cfg.botToken}/${file.file_path}`, { headers });
  }

  async deleteChunk(ref: ChunkRef): Promise<void> {
    if (ref.messageId == null) return;
    await this.call("deleteMessage", { chat_id: this.cfg.chatId, message_id: ref.messageId }, "刪除分片");
  }
}

export const telegramDriver: DriverDefinition = {
  type: "telegram",
  label: "Telegram",
  description: "以 Telegram Bot 把檔案分片（每片 ≤20MB）存到頻道或群組；檔案清單存在資料庫。",
  fields: [
    { key: "botToken", label: "Bot Token", type: "secret", required: true, placeholder: "123456:ABC-DEF…", help: "向 @BotFather 建立 Bot 取得" },
    { key: "chatId", label: "Chat ID", type: "string", required: true, placeholder: "-1001234567890 或 @channel", help: "Bot 必須是該頻道／群組成員（頻道需設為管理員）" },
    { key: "chunkSizeMB", label: "分片大小（MB）", type: "number", default: 20, help: "上限 20MB（Bot API 下載限制）" },
    { key: "apiBase", label: "API 位址", type: "string", default: "https://api.telegram.org", help: "自架 Bot API 伺服器時修改" },
  ],
  create(config, ctx: DriverContext) {
    return new RelayDriver(new TelegramBackend(config as TelegramConfig, ctx.fetch), ctx);
  },
};
