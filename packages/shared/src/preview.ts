/**
 * 預覽種類。新增預覽（office／epub／markdown…）時：在此加入種類與判斷，
 * 再於 frontend/src/previews/ 新增對應元件並在 previews/index.ts 註冊。
 */
export type PreviewKind = "image" | "video" | "audio" | "text" | "markdown" | "pdf" | "office" | "epub" | "none";

const TEXT_EXT = /\.(txt|log|json|csv|tsv|ya?ml|toml|ini|conf|xml|html?|css|js|mjs|ts|tsx|jsx|vue|py|go|rs|java|kt|c|h|cpp|hpp|sh|sql|srt|vtt)$/i;

export function previewKind(filename: string, mime?: string | null): PreviewKind {
  const m = (mime || "").toLowerCase();
  const f = filename.toLowerCase();
  if (/\.(md|markdown)$/.test(f)) return "markdown";
  if (m.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/.test(f)) return "image";
  if (m.startsWith("video/") || /\.(mp4|webm|mov|m4v|mkv)$/.test(f)) return "video";
  if (m.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/.test(f)) return "audio";
  if (m === "application/pdf" || f.endsWith(".pdf")) return "pdf";
  if (/\.(docx?|xlsx?|pptx?)$/.test(f)) return "office";
  if (f.endsWith(".epub")) return "epub";
  if (m.startsWith("text/") || m === "application/json" || TEXT_EXT.test(f)) return "text";
  return "none";
}
