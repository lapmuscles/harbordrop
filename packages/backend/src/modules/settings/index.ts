import type { HdModule } from "../types";
import { requireAdmin } from "../../core/auth";
import type { PublicConfig } from "@harbordrop/shared";

export const settingsModule: HdModule = {
  name: "settings",
  routes(app) {
    app.get("/api/public/config", async (c) => {
      const ctx = c.get("ctx");
      const p = c.get("principal");
      const pub = await ctx.settings.publicValues();
      const rows = (await ctx.storage.list()).filter((r) => r.enabled);
      const allowed = p.kind === "admin" || p.kind === "apikey" ? rows : pub.allowAnonymousUpload ? rows.filter((r) => r.allow_anonymous_upload) : [];
      const body: PublicConfig = {
        siteTitle: String(pub.siteTitle),
        allowAnonymousUpload: !!pub.allowAnonymousUpload,
        anonymousMaxBytes: Number(pub.anonymousMaxBytes) || 0,
        uploadStorages: allowed.map((r) => ({ id: r.id, name: r.name, type: r.type })),
      };
      return c.json({ ...pub, ...body });
    });
    app.get("/api/admin/settings", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      return c.json({ values: await ctx.settings.all(), definitions: ctx.settings.definitions() });
    });
    app.put("/api/admin/settings", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      await ctx.settings.update(await c.req.json());
      return c.json({ values: await ctx.settings.all() });
    });
  },
};
