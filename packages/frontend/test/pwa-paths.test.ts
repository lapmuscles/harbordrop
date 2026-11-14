import { describe, expect, it } from "vitest";
import { BACKEND_PATHS } from "../src/pwa-paths";

const isBackend = (p: string) => BACKEND_PATHS.some((r) => r.test(p));

describe("PWA navigateFallback 排除清單", () => {
  it("後端路徑被排除", () => {
    for (const p of ["/api", "/api/site", "/dav", "/dav/a/b.txt", "/f/abc/raw", "/f/abc/raw/x.bin", "/p/xyz/raw"]) expect(isBackend(p), p).toBe(true);
  });
  it("前端路由仍走 SPA fallback", () => {
    for (const p of ["/", "/admin", "/admin/settings", "/f/abc", "/p/xyz", "/paste", "/apix", "/davinci", "/f/raw"]) expect(isBackend(p), p).toBe(false);
  });
});
