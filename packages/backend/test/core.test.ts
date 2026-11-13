import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSqliteDb } from "../src/db/sqlite";
import { migrate } from "../src/db/migrate";
import { hashPassword, verifyPassword, SecretBox } from "../src/core/crypto";
import { signToken, verifyToken } from "../src/core/sign";
import { normalizePath, contentDisposition } from "../src/storage/util";
import { choosePartSize } from "../src/storage/drivers/s3";
import { renderUploadPath, sanitizeFilename } from "../src/modules/uploads";
import { can } from "../src/core/auth";
import { MIGRATIONS } from "../src/db/migrations/index.gen";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("資料庫", () => {
  it("遷移建立完整資料表，且可重複執行", async () => {
    const db = createSqliteDb(new Database(":memory:"));
    expect(await migrate(db)).toEqual(["0001_init.sql"]);
    expect(await migrate(db)).toEqual([]);
    const tables = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map((r) => r.name);
    for (const t of ["admins", "sessions", "api_keys", "api_key_acl", "settings", "storages", "mounts", "upload_sessions", "shares", "pastes", "fs_meta", "search_index", "scheduled_jobs", "tasks"])
      expect(tables).toContain(t);
  });
  it("內嵌遷移與 .sql 檔一致（請執行 npm run gen:migrations）", () => {
    const dir = join(__dirname, "../src/db/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    expect(MIGRATIONS.map((m) => m.name)).toEqual(files);
    for (const m of MIGRATIONS) expect(m.sql).toBe(readFileSync(join(dir, m.name), "utf8"));
  });
  it("batch 為交易：失敗時全部回滾", async () => {
    const db = createSqliteDb(new Database(":memory:"));
    await migrate(db);
    await expect(
      db.batch([
        { sql: "INSERT INTO settings (key, value, updated_at) VALUES ('a', '1', 0)" },
        { sql: "INSERT INTO settings (key, value, updated_at) VALUES ('a', '2', 0)" },
      ]),
    ).rejects.toThrow();
    expect(await db.first("SELECT * FROM settings WHERE key = 'a'")).toBeNull();
  });
});

describe("密碼與加密", () => {
  it("PBKDF2 雜湊與驗證", async () => {
    const h = await hashPassword("秘密 pass");
    expect(h).toMatch(/^pbkdf2\$sha256\$100000\$/);
    expect(await verifyPassword("秘密 pass", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("SecretBox 往返，且不同金鑰無法解密", async () => {
    const a = new SecretBox("0123456789abcdef-A");
    const sealed = await a.seal({ token: "hf_xxx" });
    expect(sealed).not.toContain("hf_xxx");
    expect(await a.open(sealed)).toEqual({ token: "hf_xxx" });
    await expect(new SecretBox("0123456789abcdef-B").open(sealed)).rejects.toThrow();
  });
  it("短效簽章權杖", async () => {
    const t = await signToken("k", "share:x", 60);
    expect(await verifyToken("k", "share:x", t)).toBe(true);
    expect(await verifyToken("k", "share:y", t)).toBe(false);
    expect(await verifyToken("k2", "share:x", t)).toBe(false);
  });
});

describe("工具函式", () => {
  it("路徑正規化拒絕 ..", () => {
    expect(normalizePath("a//b/./c/")).toBe("/a/b/c");
    expect(() => normalizePath("/a/../b")).toThrow();
  });
  it("中文檔名 Content-Disposition", () => {
    expect(contentDisposition("報告.pdf", true)).toBe(`inline; filename="__.pdf"; filename*=UTF-8''${encodeURIComponent("報告.pdf")}`);
  });
  it("S3 分片大小：最少 5MB，最多 10000 片", () => {
    expect(choosePartSize(100, 16 << 20)).toBe(16 << 20);
    expect(choosePartSize(100, 1)).toBe(5 << 20);
    const big = 5 * 1024 ** 4; // 5 TiB
    expect(Math.ceil(big / choosePartSize(big, 16 << 20))).toBeLessThanOrEqual(10000);
  });
  it("上傳路徑範本與檔名清理", () => {
    expect(sanitizeFilename("../a/b\\c.txt")).toBe("_a_b_c.txt");
    expect(renderUploadPath("/{yyyy}/{mm}/{dd}/{rand}/{name}", "x.bin", new Date(Date.UTC(2026, 0, 2)))).toMatch(/^\/2026\/01\/02\/[A-Za-z0-9]{8}\/x\.bin$/);
  });
  it("API 金鑰 ACL 判斷", () => {
    const key = { kind: "apikey" as const, id: 1, name: "k", permissions: ["upload", "fs.read"], acl: [{ storageId: 2, pathPrefix: "/pub", perms: ["read"] }] };
    expect(can({ kind: "admin", id: 1, username: "a" }, "anything")).toBe(true);
    expect(can({ kind: "anon" }, "upload")).toBe(false);
    expect(can(key, "fs.read", { storageId: 2, path: "/pub/a" })).toBe(true);
    expect(can(key, "fs.read", { storageId: 2, path: "/private" })).toBe(false);
    expect(can(key, "fs.read", { storageId: 3, path: "/pub" })).toBe(false);
    expect(can(key, "fs.write", { storageId: 2, path: "/pub" })).toBe(false);
  });
});
