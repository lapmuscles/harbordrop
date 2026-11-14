import type { HdModule } from "../types";
import { requireAdmin } from "../../core/auth";
import { badRequest } from "../../core/errors";
import { DRIVERS } from "../../storage/registry";
import { mountStorageOAuth } from "./oauth";

/** 儲存設定 CRUD（僅管理員）。回應永不含機密欄位值 */
export const storagesModule: HdModule = {
  name: "storages",
  routes(app) {
    mountStorageOAuth(app); // feat/ms-google
    app.get("/api/admin/storage-types", (c) => {
      requireAdmin(c);
      const platform = c.get("ctx").platform;
      return c.json(
        DRIVERS.filter((d) => !d.platforms || d.platforms.includes(platform)).map((d) => ({
          type: d.type,
          label: d.label,
          description: d.description,
          fields: d.fields,
          readonly: d.readonly,
          oauth: !!d.oauth,
        })),
      );
    });

    app.get("/api/admin/storages", async (c) => {
      requireAdmin(c);
      const s = c.get("ctx").storage;
      return c.json(await Promise.all((await s.list()).map((r) => s.toDto(r))));
    });

    app.get("/api/admin/storages/:id", async (c) => {
      requireAdmin(c);
      const s = c.get("ctx").storage;
      return c.json(await s.toDto(await s.row(Number(c.req.param("id")))));
    });

    app.post("/api/admin/storages", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const b = await c.req.json<any>();
      if (!b.name || !b.type) throw badRequest("請填寫名稱與類型");
      const { config, sealed } = await ctx.storage.split(b.type, b.config ?? {});
      const now = Date.now();
      if (b.isDefault) await ctx.db.run("UPDATE storages SET is_default = 0");
      const r = await ctx.db.run(
        "INSERT INTO storages (name, type, config, secrets, enabled, is_default, allow_anonymous_upload, remark, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [b.name, b.type, JSON.stringify(config), sealed, b.enabled ?? true, !!b.isDefault, !!b.allowAnonymousUpload, b.remark ?? null, Number(b.sort) || 0, now, now],
      );
      return c.json(await ctx.storage.toDto(await ctx.storage.row(r.lastRowId)), 201);
    });

    app.put("/api/admin/storages/:id", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const id = Number(c.req.param("id"));
      const old = await ctx.storage.row(id);
      const b = await c.req.json<any>();
      const { config, sealed } = await ctx.storage.split(old.type, b.config ?? JSON.parse(old.config), old.secrets);
      if (b.isDefault) await ctx.db.run("UPDATE storages SET is_default = 0 WHERE id != ?", [id]);
      await ctx.db.run(
        "UPDATE storages SET name = ?, config = ?, secrets = ?, enabled = ?, is_default = ?, allow_anonymous_upload = ?, remark = ?, sort = ?, updated_at = ? WHERE id = ?",
        [
          b.name ?? old.name,
          JSON.stringify(config),
          sealed,
          b.enabled ?? !!old.enabled,
          b.isDefault ?? !!old.is_default,
          b.allowAnonymousUpload ?? !!old.allow_anonymous_upload,
          b.remark ?? old.remark,
          b.sort ?? old.sort,
          Math.max(Date.now(), old.updated_at + 1),
          id,
        ],
      );
      ctx.storage.invalidate(id);
      return c.json(await ctx.storage.toDto(await ctx.storage.row(id)));
    });

    app.delete("/api/admin/storages/:id", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const id = Number(c.req.param("id"));
      await ctx.db.run("DELETE FROM storages WHERE id = ?", [id]);
      ctx.storage.invalidate(id);
      return c.json({ ok: true });
    });

    app.post("/api/admin/storages/:id/test", async (c) => {
      requireAdmin(c);
      const d = await c.get("ctx").storage.driver(Number(c.req.param("id")));
      return c.json(await d.testConnection());
    });
  },
};
