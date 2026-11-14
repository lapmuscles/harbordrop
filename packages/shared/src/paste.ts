/** 文字分享（pastes 模組）的 API 型別 */

/** markdown | text | code:<lang> */
export type PasteFormat = string;

export interface PasteCreateInput {
  title?: string;
  content: string;
  format?: PasteFormat;
  slug?: string;
  password?: string;
  /** 小時；0 或未填 = 永不過期（匿名時受 anonymousMaxExpiryHours 限制） */
  expiresInHours?: number;
  maxViews?: number;
  remark?: string;
}

export interface PasteInfo {
  slug: string;
  title: string | null;
  format: PasteFormat;
  size: number;
  expiresAt: number | null;
  maxViews: number | null;
  views: number;
  createdAt: number;
  updatedAt: number;
  passwordRequired: boolean;
  /** 已解鎖（無密碼或 token 正確）時才有內容 */
  content?: string;
}

export interface PasteAdminItem extends PasteInfo {
  id: number;
  remark: string | null;
  createdBy: string;
  /** 內容前 200 字 */
  excerpt: string;
}

export const PASTE_FORMATS = ["markdown", "text", "code"] as const;

/** 常用程式語言（code:<lang> 的 lang；highlight.js 名稱） */
export const PASTE_LANGS = [
  "plaintext", "javascript", "typescript", "python", "go", "rust", "java", "kotlin", "c", "cpp", "csharp", "php", "ruby",
  "swift", "bash", "shell", "sql", "json", "yaml", "xml", "css", "scss", "markdown", "ini", "diff", "dockerfile",
] as const;

export function parsePasteFormat(f: string | null | undefined): { kind: "markdown" | "text" | "code"; lang?: string } {
  if (!f || f === "markdown") return { kind: "markdown" };
  if (f === "text") return { kind: "text" };
  if (f.startsWith("code:")) return { kind: "code", lang: f.slice(5) || undefined };
  if (f === "code") return { kind: "code" };
  return { kind: "text" };
}
