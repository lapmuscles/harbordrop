import { beforeEach, describe, expect, it } from "vitest";
import { makeApp } from "./helpers/app";
import { memFsStores, memfsDriver } from "./helpers/memory-driver";
import { DRIVERS } from "../src/storage/registry";
import { runTasks } from "../src/modules/tasks/service";
import { searchModule } from "../src/modules/search";
import { ensureFts } from "../src/modules/search/service";

if (!DRIVERS.includes(memfsDriver)) DRIVERS.push(memfsDriver);
beforeEach(() => memFsStores.clear());

const enc = (s: string) => new TextEncoder().encode(s);
const put = (label: string, path: string, s = "x") => {
  const m = memFsStores.get(label) ?? new Map([["/", "dir" as const]]);
  memFsStores.set(label, m);
  const parts = path.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++) m.set("/" + parts.slice(0, i).join("/"), "dir");
  m.set(path, enc(s));
};

async function setup() {
  const h = await makeApp();
  const auth = { authorization: `Bearer ${await h.login()}` };
  const mk = async (label: string) => (await h.call("POST", "/api/admin/storages", { name: label, type: "memfs", config: { label } }, auth)).json.id as number;
  const a = await mk("A");
  const b = await mk("B");
  const m1 = (await h.call("POST", "/api/admin/mounts", { mountPath: "/a", storageId: a, rootPath: "/data" }, auth)).json;
  const m2 = (await h.call("POST", "/api/admin/mounts", { mountPath: "/b", storageId: b }, auth)).json;
  put("A", "/data/報告/年度財務報告.pdf");
  put("A", "/data/報告/notes.txt");
  put("A", "/data/.git/config");
  put("A", "/data/secret/plan-report.txt");
  put("A", "/outside.txt");
  put("B", "/photos/2026/beach-report.jpg");
  const reindex = async (body: unknown = {}) => {
    const r = await h.call("POST", "/api/admin/search/reindex", body, auth);
    expect(r.status).toBe(202);
    for (let i = 0; i < 20; i++) {
      await runTasks(h.ctx, { budgetMs: 5000 });
      const t = (await h.call("GET", `/api/admin/tasks/${r.json.taskId}`, undefined, auth)).json;
      if (t.status !== "pending" && t.status !== "running") return t;
    }
    throw new Error("reindex did not finish");
  };
  const search = (q: string, headers: Record<string, string> = auth, extra = "") =>
    h.call("GET", `/api/search?q=${encodeURIComponent(q)}${extra}`, undefined, headers);
  return { ...h, auth, a, b, m1, m2, reindex, search };
}

describe("search", () => {
  it("使用 trigram tokenizer（better-sqlite3 支援）", async () => {
    const h = await setup();
    expect(await ensureFts(h.ctx)).toBe("trigram");
  });

  it("重建索引（BFS）後可搜尋中文與英文；短詞走 LIKE", async () => {
    const h = await setup();
    const t = await h.reindex();
    expect(t.status).toBe("succeeded");
    expect(t.result.indexed).toBeGreaterThanOrEqual(10);
    const zh = await h.search("財務報");
    expect(zh.status).toBe(200);
    expect(zh.json.results.map((r: any) => r.path)).toEqual(["/a/報告/年度財務報告.pdf"]);
    const short = await h.search("報告");
    expect(short.json.results.map((r: any) => r.path).sort()).toEqual(["/a/報告", "/a/報告/年度財務報告.pdf"]);
    const en = await h.search("report");
    expect(en.json.results.map((r: any) => r.path).sort()).toEqual(["/a/secret/plan-report.txt", "/b/photos/2026/beach-report.jpg"]);
    // root_path 之外的檔案不會被索引
    expect((await h.search("outside")).json.results).toEqual([]);
    // 多詞 AND
    expect((await h.search("beach report")).json.results.map((r: any) => r.name)).toEqual(["beach-report.jpg"]);
  });

  it("mount 參數限制範圍（路徑或 ID）", async () => {
    const h = await setup();
    await h.reindex();
    expect((await h.search("report", h.auth, "&mount=/b")).json.results.map((r: any) => r.path)).toEqual(["/b/photos/2026/beach-report.jpg"]);
    expect((await h.search("report", h.auth, `&mount=${h.m1.id}`)).json.results.map((r: any) => r.path)).toEqual(["/a/secret/plan-report.txt"]);
  });

  it("套用 fsmeta 隱藏、密碼與 API 金鑰 ACL", async () => {
    const h = await setup();
    await h.reindex();
    await h.call("POST", "/api/admin/fs-meta", { path: "/a", hidePatterns: [".*"] }, h.auth);
    await h.call("POST", "/api/admin/fs-meta", { path: "/a/secret", password: "pw" }, h.auth);
    const key = (await h.call("POST", "/api/admin/api-keys", { name: "k", permissions: ["fs.read"] }, h.auth)).json.key;
    const K = { "x-api-key": key };
    expect((await h.search("config", K)).json.results).toEqual([]);
    expect((await h.search("report", K)).json.results.map((r: any) => r.path)).toEqual(["/b/photos/2026/beach-report.jpg"]);
    // 管理員不受限
    expect((await h.search("config")).json.results.length).toBe(1);
    const scoped = (await h.call("POST", "/api/admin/api-keys", { name: "s", permissions: ["fs.read"], acl: [{ pathPrefix: "/a", perms: ["read"] }] }, h.auth)).json.key;
    expect((await h.search("report", { "x-api-key": scoped })).json.results).toEqual([]);
    const noPerm = (await h.call("POST", "/api/admin/api-keys", { name: "n", permissions: ["upload"] }, h.auth)).json.key;
    expect((await h.search("report", { "x-api-key": noPerm })).status).toBe(403);
  });

  it("匿名需開啟 fsPublicBrowse；空查詢 400", async () => {
    const h = await setup();
    await h.reindex();
    expect((await h.search("report", {})).status).toBe(401);
    await h.call("PUT", "/api/admin/settings", { fsPublicBrowse: true }, h.auth);
    expect((await h.search("report", {})).json.results.length).toBe(2);
    expect((await h.search("  ")).status).toBe(400);
  });

  it("單一掛載重建會替換舊資料；狀態端點；排程 job", async () => {
    const h = await setup();
    await h.reindex();
    memFsStores.get("B")!.delete("/photos/2026/beach-report.jpg");
    put("B", "/new-report.md");
    await h.reindex({ mountId: h.m2.id });
    expect((await h.search("report", h.auth, "&mount=/b")).json.results.map((r: any) => r.path)).toEqual(["/b/new-report.md"]);
    expect((await h.search("report")).json.results.length).toBe(2);
    const st = (await h.call("GET", "/api/admin/search/status", undefined, h.auth)).json;
    expect(st.tokenizer).toBe("trigram");
    expect(st.entries).toBeGreaterThan(5);
    const msg = await searchModule.jobs!["search.reindex"](h.ctx, {});
    expect(msg).toContain("已建立");
    expect(await searchModule.jobs!["search.reindex"](h.ctx, {})).toContain("略過");
  });
});
