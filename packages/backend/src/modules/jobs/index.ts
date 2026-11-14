import type { HdModule } from "../types";
import { requireAdmin } from "../../core/auth";
import { badRequest } from "../../core/errors";
import { JOB_KIND_LABELS, cleanupExpired, createJob, cronTick, deleteJob, getJob, jobHandlers, listJobs, runJob, toDto, updateJob } from "./service";

function idParam(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest("ID 格式錯誤");
  return n;
}

/** 排程工作。規格見 docs/MODULES-zhTW.md#jobs */
export const jobsModule: HdModule = {
  name: "jobs",
  jobs: { "cleanup.expired": cleanupExpired },
  async cron(ctx) {
    await cronTick(ctx);
  },
  routes(app) {
    app.get("/api/admin/jobs/kinds", (c) => {
      requireAdmin(c);
      const kinds = [...jobHandlers(c.get("ctx")).keys()].map((k) => ({ kind: k, label: JOB_KIND_LABELS[k] ?? k }));
      return c.json({ items: kinds });
    });
    app.get("/api/admin/jobs", async (c) => {
      requireAdmin(c);
      return c.json({ items: await listJobs(c.get("ctx")) });
    });
    app.post("/api/admin/jobs", async (c) => {
      requireAdmin(c);
      return c.json(await createJob(c.get("ctx"), await c.req.json()), 201);
    });
    app.get("/api/admin/jobs/:id", async (c) => {
      requireAdmin(c);
      return c.json(toDto(await getJob(c.get("ctx"), idParam(c.req.param("id")))));
    });
    app.patch("/api/admin/jobs/:id", async (c) => {
      requireAdmin(c);
      return c.json(await updateJob(c.get("ctx"), idParam(c.req.param("id")), await c.req.json()));
    });
    app.delete("/api/admin/jobs/:id", async (c) => {
      requireAdmin(c);
      await deleteJob(c.get("ctx"), idParam(c.req.param("id")));
      return c.json({ ok: true });
    });
    /** 立即執行（同步等待結果；不影響 enabled） */
    app.post("/api/admin/jobs/:id/run", async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      return c.json(await runJob(ctx, await getJob(ctx, idParam(c.req.param("id")))));
    });
  },
};
