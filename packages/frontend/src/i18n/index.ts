import zhTW from "./zh-TW";

/**
 * 極簡 i18n：t("upload.title", { n: 1 })。目前僅 zh-TW；
 * 之後若需多語系可替換為 vue-i18n，呼叫方式維持 t(key, params)。
 */
const messages: Record<string, any> = { "zh-TW": zhTW };
let locale = "zh-TW";

export function setLocale(l: string) {
  if (messages[l]) locale = l;
}

export function t(key: string, params: Record<string, string | number> = {}): string {
  const v = key.split(".").reduce<any>((o, k) => o?.[k], messages[locale]) ?? key;
  return String(v).replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "-";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function formatTime(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString("zh-TW", { hour12: false }) : "-";
}
