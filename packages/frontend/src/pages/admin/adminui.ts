import { HdApiError } from "@harbordrop/shared/upload";
import { t } from "../../i18n";

/** 複製文字到剪貼簿；不支援 Clipboard API 時退回 execCommand */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** 取出錯誤訊息（後端錯誤已是繁中） */
export function errMsg(e: unknown): string {
  if (e instanceof HdApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 秒數轉為易讀文字（每 N 分鐘／小時／天） */
export function humanInterval(sec: number): string {
  const units: [number, string][] = [
    [86400, "天"],
    [3600, "小時"],
    [60, "分鐘"],
    [1, "秒"],
  ];
  if (!Number.isFinite(sec) || sec <= 0) return "-";
  for (const [n, u] of units) if (sec % n === 0) return t("adminui.jobs.every", { n: `${sec / n} ${u}` });
  return `${sec} 秒`;
}

/** datetime-local 字串 ↔ 毫秒 */
export function toLocalInput(ms: number | null | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(s: string): number | null {
  if (!s) return null;
  const n = new Date(s).getTime();
  return Number.isFinite(n) ? n : null;
}
