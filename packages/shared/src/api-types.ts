/** 前後端共用的 API 資料型別（DTO） */

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface PublicConfig {
  siteTitle: string;
  allowAnonymousUpload: boolean;
  anonymousMaxBytes: number;
  /** 目前登入者可選的上傳儲存 */
  uploadStorages: { id: number; name: string; type: string }[];
}

export interface Me {
  kind: "admin" | "apikey" | "anon";
  username?: string;
}

export interface ShareOptionsInput {
  slug?: string;
  password?: string;
  /** 小時；0 或未填 = 永不過期 */
  expiresInHours?: number;
  maxViews?: number;
  remark?: string;
}

export interface UploadInitRequest {
  storageId: number;
  filename: string;
  size: number;
  mime?: string;
  share?: ShareOptionsInput;
}

export interface UploadInitResponse {
  sessionId: string;
  uploadToken: string;
  protocol: string;
  /** 驅動提供的協定參數 */
  client: Record<string, any>;
  partSize?: number;
}

export interface ShareInfo {
  slug: string;
  filename: string;
  size: number;
  mime: string | null;
  sha256: string | null;
  expiresAt: number | null;
  maxViews: number | null;
  views: number;
  createdAt: number;
  passwordRequired: boolean;
  previewKind: string;
}

export interface UploadCompleteResponse {
  share: ShareInfo;
  url: string;
}

export interface StorageTypeField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
}

export interface StorageTypeInfo {
  type: string;
  label: string;
  description?: string;
  fields: StorageTypeField[];
  readonly?: boolean;
}

export interface StorageDto {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  /** 已設定的機密欄位名稱（值永不回傳） */
  secretsSet: string[];
  enabled: boolean;
  isDefault: boolean;
  allowAnonymousUpload: boolean;
  remark: string | null;
  sort: number;
  createdAt: number;
  updatedAt: number;
}
