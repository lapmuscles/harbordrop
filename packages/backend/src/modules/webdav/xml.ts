/** WebDAV XML／路徑工具（純函式，方便測試） */

export const DAV_PREFIX = "/dav";

export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
}

/** 虛擬路徑 → href（每段 URL 編碼，中文等非 ASCII 字元以 UTF-8 百分比編碼；集合結尾加 /） */
export function hrefFor(vpath: string, isDir: boolean): string {
  const segs = vpath.split("/").filter(Boolean).map((s) => encodeURIComponent(s));
  const p = DAV_PREFIX + "/" + segs.join("/");
  return isDir && !p.endsWith("/") ? p + "/" : p;
}

/**
 * 請求路徑（URL pathname，含 /dav 前綴）→ 虛擬路徑。逐段解碼；含 . / .. / 反斜線 / 控制字元時回傳 null。
 */
export function davPathToVpath(pathname: string): string | null {
  if (pathname !== DAV_PREFIX && !pathname.startsWith(DAV_PREFIX + "/")) return null;
  const raw = pathname.slice(DAV_PREFIX.length);
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "") continue;
    let s: string;
    try {
      s = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (s === "." || s === ".." || /[\\/\x00-\x1f\x7f]/.test(s)) return null;
    out.push(s);
  }
  return "/" + out.join("/");
}

/** Destination 標頭（絕對 URL 或路徑）→ 虛擬路徑 */
export function destinationToVpath(dest: string | undefined | null): string | null {
  if (!dest) return null;
  let pathname: string;
  try {
    pathname = new URL(dest, "http://x").pathname;
  } catch {
    return null;
  }
  return davPathToVpath(pathname);
}

export interface DavProps {
  vpath: string;
  name: string;
  isDir: boolean;
  size?: number;
  modifiedAt?: number;
  mime?: string;
  etag?: string;
}

const httpDate = (ms: number) => new Date(ms).toUTCString();

export function propResponse(p: DavProps): string {
  const props: string[] = [
    `<D:displayname>${xmlEscape(p.name)}</D:displayname>`,
    p.isDir ? "<D:resourcetype><D:collection/></D:resourcetype>" : "<D:resourcetype/>",
  ];
  if (!p.isDir) {
    props.push(`<D:getcontentlength>${Math.max(0, Math.floor(p.size ?? 0))}</D:getcontentlength>`);
    props.push(`<D:getcontenttype>${xmlEscape(p.mime || "application/octet-stream")}</D:getcontenttype>`);
  }
  if (p.modifiedAt) {
    props.push(`<D:getlastmodified>${httpDate(p.modifiedAt)}</D:getlastmodified>`);
    props.push(`<D:creationdate>${new Date(p.modifiedAt).toISOString()}</D:creationdate>`);
  }
  const etag = p.etag ?? (p.isDir ? undefined : `"${(p.size ?? 0).toString(16)}-${(p.modifiedAt ?? 0).toString(16)}"`);
  if (etag) props.push(`<D:getetag>${xmlEscape(etag.startsWith('"') || etag.startsWith("W/") ? etag : `"${etag}"`)}</D:getetag>`);
  props.push(
    "<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>",
    "<D:lockdiscovery/>",
  );
  return `<D:response><D:href>${xmlEscape(hrefFor(p.vpath, p.isDir))}</D:href><D:propstat><D:prop>${props.join("")}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

export function multistatus(responses: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${responses.join("")}</D:multistatus>`;
}

/** LOCK 回應（假鎖：不真正鎖定，只讓 Windows／macOS 能以讀寫模式掛載） */
export function lockResponse(token: string, href: string, owner: string, timeoutSec: number, depth: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
    `<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>${xmlEscape(depth)}</D:depth>` +
    (owner ? `<D:owner>${owner}</D:owner>` : "") +
    `<D:timeout>Second-${timeoutSec}</D:timeout><D:locktoken><D:href>${xmlEscape(token)}</D:href></D:locktoken>` +
    `<D:lockroot><D:href>${xmlEscape(href)}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`
  );
}

/** 從 LOCK 請求體取出 <owner> 內容（原樣保留內部 XML，但移除可疑字元） */
export function extractOwner(body: string): string {
  const m = body.match(/<(?:[a-zA-Z0-9]+:)?owner[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?owner>/);
  if (!m) return "";
  const inner = m[1].trim();
  // 只接受簡單內容：<D:href>…</D:href> 或純文字
  const href = inner.match(/<(?:[a-zA-Z0-9]+:)?href[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?href>/);
  const text = (href ? href[1] : inner.replace(/<[^>]*>/g, "")).trim();
  return text ? `<D:href>${xmlEscape(text)}</D:href>` : "";
}

/** PROPPATCH 假回應：把請求中出現的屬性一律回報 200（Windows 會寫 Win32 時間屬性） */
export function proppatchResponse(href: string, body: string): string {
  const names = new Set<string>();
  const re = /<(?:D:|d:)?(?:set|remove)[^>]*>[\s\S]*?<(?:[a-zA-Z0-9]+:)?prop[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?prop>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    for (const t of m[1].matchAll(/<([a-zA-Z0-9_]+:)?([a-zA-Z0-9_-]+)(\s[^>]*)?\/?>/g)) names.add(t[2]);
  }
  const props = [...names].map((n) => `<x:${n} xmlns:x="urn:schemas-microsoft-com:"/>`).join("");
  return multistatus([
    `<D:response><D:href>${xmlEscape(href)}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
  ]);
}

/** 解析 Range: bytes=a-b（只支援單一範圍）；不合法回傳 "invalid"，無則 null */
export function parseRange(h: string | undefined | null, size: number): { start: number; end: number } | "invalid" | null {
  if (!h) return null;
  const m = h.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null; // 多重範圍或格式外：忽略，回整檔
  let start: number, end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/** 從串流取 [start, end] 位元組（含 end） */
export function sliceStream(src: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      while (true) {
        if (pos > end) {
          ctrl.close();
          await reader.cancel().catch(() => {});
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          ctrl.close();
          return;
        }
        const chunkStart = pos;
        pos += value.byteLength;
        const from = Math.max(0, start - chunkStart);
        const to = Math.min(value.byteLength, end - chunkStart + 1);
        if (to > from) {
          ctrl.enqueue(value.subarray(from, to));
          return;
        }
      }
    },
    cancel() {
      return reader.cancel();
    },
  });
}
