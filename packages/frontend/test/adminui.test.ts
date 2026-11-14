import { describe, expect, it } from "vitest";
import { HdApiError } from "@harbordrop/shared/upload";
import { errMsg, fromLocalInput, humanInterval, toLocalInput } from "../src/pages/admin/adminui";
import zhTW from "../src/i18n/zh-TW";
import { t } from "../src/i18n";

describe("admin-ui helpers", () => {
  it("humanInterval 以最大整除單位顯示", () => {
    expect(humanInterval(3600)).toBe("每 1 小時");
    expect(humanInterval(86400 * 7)).toBe("每 7 天");
    expect(humanInterval(90)).toBe("每 90 秒");
    expect(humanInterval(300)).toBe("每 5 分鐘");
    expect(humanInterval(0)).toBe("-");
  });
  it("datetime-local 來回轉換（分鐘精度）", () => {
    const ms = new Date(2026, 10, 14, 9, 5).getTime();
    expect(toLocalInput(ms)).toBe("2026-11-14T09:05");
    expect(fromLocalInput(toLocalInput(ms))).toBe(ms);
    expect(fromLocalInput("")).toBeNull();
    expect(toLocalInput(null)).toBe("");
  });
  it("errMsg 取出後端錯誤訊息", () => {
    expect(errMsg(new HdApiError(429, "too_many_attempts", "登入失敗次數過多，請 15 分鐘後再試"))).toContain("15 分鐘");
    expect(errMsg("x")).toBe("x");
  });
  it("i18n 區塊存在且鍵可解析（含權限、排程預設）", () => {
    expect((zhTW as any).adminui).toBeTruthy();
    expect(t("adminui.apiKeys.perm.fs_read")).toBe("讀取檔案");
    expect(t("adminui.apiKeys.act.*")).toBe("全部");
    for (const p of [300, 900, 3600, 21600, 86400, 604800]) expect(t(`adminui.jobs.presets.${p}`)).not.toMatch(/^adminui\./);
    expect(t("adminui.oauth.redirectUri", { provider: "OneDrive" })).toContain("OneDrive");
  });
});
