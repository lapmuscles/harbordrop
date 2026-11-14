import type { HdModule } from "../types";
import { requireAdmin } from "../../core/auth";
import { badRequest } from "../../core/errors";
import { exportBackup, exportBackupJob, importBackup } from "./service";

/** 備份與還原。規格見 docs/MODULES-zhTW.md#backup */
export const backupModule: HdModule = {
  name: "backup",
  jobs: { "backup.export": exportBackupJob },
  routes(app) {
    app.get("/api/admin/backup/export", async (c) => {
      requireAdmin(c);
      const data = await exportBackup(c.get("ctx"));
      const d = new Date(data.exportedAt).toISOString().slice(0, 10).replace(/-/g, "");
      c.header("Content-Disposition", `attachment; filename="harbordrop-backup-${d}.json"`);
      return c.json(data);
    });

    /** 內容可為 { mode, data: <備份檔> }，或直接上傳備份檔並以 ?mode= 指定（預設 merge） */
    app.post("/api/admin/backup/import", async (c) => {
      requireAdmin(c);
      const body = await c.req.json<Record<string, unknown>>();
      const wrapped = body && typeof body === "object" && "data" in body;
      const mode = String((wrapped ? body.mode : undefined) ?? c.req.query("mode") ?? "merge");
      if (mode !== "merge" && mode !== "replace") throw badRequest("還原模式只能是 merge 或 replace");
      return c.json(await importBackup(c.get("ctx"), wrapped ? body.data : body, mode));
    });
  },
};
