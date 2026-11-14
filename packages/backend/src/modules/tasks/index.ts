import type { HdModule } from "../types";
import { requireAdmin } from "../../core/auth";
import { badRequest } from "../../core/errors";
import { cancelTask, getTask, runTasks, taskView, type TaskRow } from "./service";

/**
 * 背景工作：
 *   GET    /api/admin/tasks?status=&kind=&limit=
 *   GET    /api/admin/tasks/:id
 *   POST   /api/admin/tasks/:id/cancel
 *   DELETE /api/admin/tasks/:id         （僅限已結束的工作）
 * cron()：每分鐘在時間預算內分段推進（Workers 單次執行有限）。
 */
export const tasksModule: HdModule = {
  name: "tasks",
  routes(app) {
    app.get("/api/admin/tasks", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const where: string[] = [];
      const params: unknown[] = [];
      const status = c.req.query("status");
      const kind = c.req.query("kind");
      if (status) where.push("status = ?"), params.push(status);
      if (kind) where.push("kind = ?"), params.push(kind);
      const limit = Math.min(Math.max(Number(c.req.query("limit")) || 100, 1), 500);
      const rows = await ctx.db.all<TaskRow>(
        `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`,
        [...params, limit],
      );
      return c.json({ tasks: rows.map(taskView) });
    });

    app.get("/api/admin/tasks/:id", async (c) => {
      requireAdmin(c);
      return c.json(taskView(await getTask(c.get("ctx"), c.req.param("id"))));
    });

    app.post("/api/admin/tasks/:id/cancel", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const t = await getTask(ctx, c.req.param("id"));
      if (!(await cancelTask(ctx, t.id))) throw badRequest("工作已結束，無法取消");
      return c.json({ ok: true });
    });

    app.delete("/api/admin/tasks/:id", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const t = await getTask(ctx, c.req.param("id"));
      if (t.status === "pending" || t.status === "running") throw badRequest("工作進行中，請先取消");
      await ctx.db.run("DELETE FROM tasks WHERE id = ?", [t.id]);
      return c.json({ ok: true });
    });
  },
  async cron(ctx) {
    await runTasks(ctx, { budgetMs: 20_000 });
  },
};
