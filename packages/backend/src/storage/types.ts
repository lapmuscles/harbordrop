/**
 * 儲存驅動介面（所有渠道共用）。
 *
 * 路徑慣例：驅動收到的路徑一律為「儲存內相對路徑」，以 / 開頭（例如 /2026/11/a.bin），
 * 驅動自行套用設定中的根目錄／前綴。shares.object_path 與 mounts 皆存這種路徑。
 *
 * 位元組原則：大檔上傳一律「瀏覽器直傳」到供應商（initUpload / uploadAction / completeUpload），
 * 後端只發簽章、權杖與做最後提交；不支援直傳的渠道（Telegram、Discord、WebDAV、本機、GitHub）
 * 才使用 `put`（經後端，Workers 受請求體上限限制）或自訂的分片中繼協定。
 */

import type { Db } from "../db/adapter";

export type Platform = "workers" | "node";

export type ConfigFieldType = "string" | "secret" | "number" | "boolean" | "select" | "textarea";

/** 設定表單欄位：前端依此自動產生表單；type=secret 的欄位加密存放、永不回傳 */
export interface ConfigField {
  key: string;
  label: string;
  type: ConfigFieldType;
  required?: boolean;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
}

/** 上傳協定名稱。瀏覽器端在 @harbordrop/shared/upload 中以同名實作 */
export type UploadProtocol =
  | "xet" // HuggingFace Xet（瀏覽器 → cas-server）
  | "s3-multipart" // S3 multipart，預簽章分片 URL
  | "proxy" // 整檔經後端 put()（小檔）
  | (string & {}); // 其他渠道自訂，例如 graph-upload-session、gdrive-resumable、chunk-relay

export interface Capabilities {
  list: boolean;
  write: boolean;
  delete: boolean;
  mkdir: boolean;
  rename: boolean;
  copy: boolean;
  /** 瀏覽器直傳協定（依偏好排序） */
  uploadProtocols: UploadProtocol[];
  /** 經後端 put() 的單檔上限（位元組）；undefined = 不支援 put */
  maxProxyUploadBytes?: number;
}

export interface FileEntry {
  name: string;
  path: string; // 儲存內相對路徑
  isDir: boolean;
  size?: number;
  modifiedAt?: number; // Unix ms
  mime?: string;
  etag?: string;
  sha256?: string;
}

export interface ListResult {
  entries: FileEntry[];
  cursor?: string;
}

export interface DownloadOptions {
  filename?: string;
  /** true = 預覽（Content-Disposition: inline） */
  inline?: boolean;
  mime?: string;
  /** 原始請求（取 Range 等標頭；代理模式用） */
  request?: Request;
}

export type DownloadTarget =
  | { kind: "redirect"; url: string; expiresAt?: number }
  | { kind: "response"; response: Response };

export interface UploadInitInput {
  path: string;
  filename: string;
  size: number;
  mime?: string;
  sha256?: string;
  partSize?: number;
  /** 瀏覽器請求的 Origin 標頭（gdrive resumable session 需綁定，CORS 才會放行） */
  origin?: string;
}

export interface UploadInitResult {
  protocol: UploadProtocol;
  /** 給瀏覽器的參數（不得含任何供應商憑證） */
  client: Record<string, unknown>;
  providerUploadId?: string;
  partSize?: number;
  meta?: Record<string, unknown>;
}

/** 傳給驅動的上傳工作階段（由 upload_sessions 表還原） */
export interface UploadSessionView {
  id: string;
  protocol: UploadProtocol;
  objectPath: string;
  filename: string;
  size: number;
  mime?: string | null;
  providerUploadId?: string | null;
  partSize?: number | null;
  meta: Record<string, any>;
  state: string;
}

export interface UploadActionInput {
  /** 動作名稱之後的子路徑，例如 hub/api/datasets/x/y/commit/main */
  subpath: string;
  request: Request;
  /** 對外網址（含協定與主機），用於改寫回傳給瀏覽器的 URL */
  origin: string;
  /** 指回本工作階段 action 端點的絕對 URL 前綴 */
  actionBase: string;
}

export interface UploadActionResult {
  response: Response;
  /** 合併進 session.meta */
  meta?: Record<string, unknown>;
  state?: string;
}

export interface StorageDriver {
  readonly type: string;
  readonly capabilities: Capabilities;

  testConnection(): Promise<{ ok: boolean; message: string }>;
  stat(path: string): Promise<FileEntry | null>;
  list?(path: string, opts?: { cursor?: string; limit?: number }): Promise<ListResult>;
  download(path: string, opts?: DownloadOptions): Promise<DownloadTarget>;
  put?(path: string, body: ReadableStream<Uint8Array> | Uint8Array, opts: { size: number; mime?: string }): Promise<FileEntry>;
  delete?(paths: string[]): Promise<void>;
  mkdir?(path: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  copy?(from: string, to: string): Promise<void>;

  // —— 瀏覽器直傳生命週期 ——
  initUpload?(input: UploadInitInput): Promise<UploadInitResult>;
  uploadAction?(session: UploadSessionView, action: string, input: UploadActionInput): Promise<UploadActionResult>;
  completeUpload?(session: UploadSessionView, body: any): Promise<{ entry: FileEntry; meta?: Record<string, unknown> }>;
  abortUpload?(session: UploadSessionView): Promise<void>;

  // —— 分片中繼（chunk-relay）：每片經後端轉送到渠道 ——
  /** 收下第 index 片（0 起算）並轉送到渠道 */
  uploadChunk?(session: UploadSessionView, index: number, body: Uint8Array): Promise<{ index: number; size: number }>;
  /** 已收到的分片（續傳用） */
  listChunks?(session: UploadSessionView): Promise<{ index: number; size: number }[]>;
}

export interface DriverContext {
  platform: Platform;
  fetch: typeof fetch;
  /** Node 的資料目錄（local 驅動用） */
  dataDir?: string;
  /** 資料庫（分片中繼渠道存放 relay_objects 用；由 StorageService 注入） */
  db?: Db;
  /** 目前驅動所屬的儲存 ID（由 StorageService 注入） */
  storageId?: number;
}

export interface DriverDefinition {
  type: string;
  label: string;
  description?: string;
  fields: ConfigField[];
  /** 可運行的平台；未填 = 兩者皆可 */
  platforms?: Platform[];
  /** 唯讀渠道（mirror） */
  readonly?: boolean;
  /** 選用：OAuth 授權流程（storages 模組的 /oauth/:type/start 與 /callback 使用），用來取得 refresh token */
  oauth?: DriverOAuth;
  /** config 已合併機密欄位（已解密） */
  create(config: Record<string, any>, ctx: DriverContext): StorageDriver;
}

/** 驅動的 OAuth 授權 hook。config 為該儲存目前的設定（已合併機密） */
export interface DriverOAuth {
  /** 存放 refresh token 的 secret 欄位 key */
  tokenField: string;
  authorizeUrl(input: { config: Record<string, any>; redirectUri: string; state: string }): string;
  exchangeCode(input: { config: Record<string, any>; redirectUri: string; code: string; fetch: typeof fetch }): Promise<{ refreshToken: string }>;
}
