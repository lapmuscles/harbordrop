import type { HdModule } from "../types";
import { requireAdmin } from "../../core/auth";
import { badRequest, notFound } from "../../core/errors";
import { authenticate, createApiKey, deleteApiKey, getApiKey, listApiKeys, replaceAcl, updateApiKey, validateAcl } from "./service";

function idParam(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest("ID 格式錯誤");
  return n;
}

/** API 金鑰：管理路由 + 請求驗證（X-API-Key／Bearer hd_…）。規格見 docs/MODULES-zhTW.md#apikeys */
export const apikeysModule: HdModule = {
  name: "apikeys",
  authenticate,
  routes(app) {
    app.get("/api/admin/api-keys", async (c) => {
      requireAdmin(c);
      return c.json({ items: await listApiKeys(c.get("ctx")) });
    });
    app.post("/api/admin/api-keys", async (c) => {
      requireAdmin(c);
      const created = await createApiKey(c.get("ctx"), await c.req.json());
      return c.json(created, 201);
    });
    app.get("/api/admin/api-keys/:id", async (c) => {
      requireAdmin(c);
      return c.json(await getApiKey(c.get("ctx"), idParam(c.req.param("id"))));
    });
    app.patch("/api/admin/api-keys/:id", async (c) => {
      requireAdmin(c);
      return c.json(await updateApiKey(c.get("ctx"), idParam(c.req.param("id")), await c.req.json()));
    });
    app.delete("/api/admin/api-keys/:id", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const id = idParam(c.req.param("id"));
      await getApiKey(ctx, id);
      await deleteApiKey(ctx, id);
      return c.json({ ok: true });
    });
    app.put("/api/admin/api-keys/:id/acl", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const id = idParam(c.req.param("id"));
      const exists = await ctx.db.first("SELECT id FROM api_keys WHERE id = ?", [id]);
      if (!exists) throw notFound("找不到 API 金鑰");
      await replaceAcl(ctx, id, validateAcl(await c.req.json()));
      return c.json(await getApiKey(ctx, id));
    });
  },
};
