/** 正規化路徑：以 / 開頭、不含 . / .. / 重複斜線、結尾無 / */
export function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of (p || "").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") throw new Error("路徑不可包含 ..");
    out.push(seg);
  }
  return "/" + out.join("/");
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join("/"));
}

/** RFC 6266 / 5987：中文檔名需 filename* */
export function contentDisposition(filename: string, inline = false): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", m4v: "video/mp4",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", opus: "audio/ogg",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", log: "text/plain",
  html: "text/html", css: "text/css", js: "text/javascript", ts: "text/plain", xml: "application/xml", yaml: "text/yaml", yml: "text/yaml",
  zip: "application/zip", epub: "application/epub+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

