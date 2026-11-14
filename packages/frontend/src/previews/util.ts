/** 預覽共用工具 */
export const TEXT_MAX = 1024 * 1024;

/** 讀取文字（最多前 1MB），回傳 [文字, 是否截斷] */
export async function fetchText(src: string, size?: number): Promise<[string, boolean]> {
  const big = (size ?? 0) > TEXT_MAX;
  const r = await fetch(src, { headers: big ? { Range: `bytes=0-${TEXT_MAX - 1}` } : {} });
  if (!r.ok && r.status !== 206) throw new Error(`讀取失敗（HTTP ${r.status}）`);
  const buf = await r.arrayBuffer();
  return [new TextDecoder().decode(buf.slice(0, TEXT_MAX)), big || buf.byteLength > TEXT_MAX];
}

export async function fetchBuffer(src: string): Promise<ArrayBuffer> {
  const r = await fetch(src);
  if (!r.ok) throw new Error(`讀取失敗（HTTP ${r.status}）`);
  return r.arrayBuffer();
}

export const extOf = (name = "") => (/\.([^./]+)$/.exec(name.toLowerCase())?.[1] ?? "");

/** 副檔名 → highlight.js 語言 */
export const CODE_EXT: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  vue: "xml", html: "xml", htm: "xml", xml: "xml", svg: "xml", css: "css", scss: "scss", less: "less",
  json: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", conf: "ini",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
  cs: "csharp", php: "php", rb: "ruby", swift: "swift", sh: "bash", bash: "bash", zsh: "bash", sql: "sql",
  diff: "diff", patch: "diff", lua: "lua", pl: "perl", r: "r", dockerfile: "dockerfile", makefile: "makefile",
};
