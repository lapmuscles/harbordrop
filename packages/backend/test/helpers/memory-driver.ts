import type { DriverDefinition, FileEntry, StorageDriver } from "../../src/storage/types";

/** 測試用記憶體驅動：模擬「瀏覽器直傳」協定 mem-direct（client 直接 PUT 到 action/put） */
export const memFiles = new Map<string, Uint8Array>();

export const memoryDriver: DriverDefinition = {
  type: "memory",
  label: "記憶體（測試）",
  fields: [
    { key: "label", label: "標籤", type: "string" },
    { key: "secretKey", label: "機密", type: "secret", required: true },
  ],
  create(config): StorageDriver {
    return {
      type: "memory",
      capabilities: { list: false, write: true, delete: true, mkdir: false, rename: false, copy: false, uploadProtocols: ["mem-direct"] },
      async testConnection() {
        return { ok: config.secretKey === "s3cret", message: "ok" };
      },
      async stat(path): Promise<FileEntry | null> {
        const b = memFiles.get(path);
        return b ? { name: path.split("/").pop()!, path, isDir: false, size: b.byteLength } : null;
      },
      async download(path, opts) {
        const b = memFiles.get(path);
        if (!b) throw new Error("missing");
        return { kind: "response", response: new Response(b as BodyInit, { headers: { "content-disposition": opts?.inline ? "inline" : "attachment" } }) };
      },
      async delete(paths) {
        for (const p of paths) memFiles.delete(p);
      },
      async initUpload() {
        return { protocol: "mem-direct", client: {} };
      },
      async uploadAction(session, action, input) {
        memFiles.set(session.objectPath, new Uint8Array(await input.request.arrayBuffer()));
        return { response: Response.json({ ok: true }), state: "uploading", meta: { action } };
      },
      async completeUpload(session) {
        const b = memFiles.get(session.objectPath);
        if (!b || b.byteLength !== session.size) throw new Error("size mismatch");
        return { entry: { name: session.filename, path: session.objectPath, isDir: false, size: b.byteLength } };
      },
    };
  },
};

/**
 * 測試用「完整檔案系統」記憶體驅動（type: memfs）：支援 list/mkdir/rename/copy/put/delete 與 mem-direct 直傳。
 * 以設定的 label 區分不同儲存（memFsStores.get(label)）；capabilities 可用 config.noCopy 關閉原生 copy/rename。
 */
export const memFsStores = new Map<string, Map<string, Uint8Array | "dir">>();

export const memfsDriver: DriverDefinition = {
  type: "memfs",
  label: "記憶體檔案系統（測試）",
  fields: [
    { key: "label", label: "標籤", type: "string", required: true },
    { key: "noCopy", label: "停用原生複製", type: "boolean" },
  ],
  create(config): StorageDriver {
    const label = String(config.label);
    const store = () => {
      let s = memFsStores.get(label);
      if (!s) memFsStores.set(label, (s = new Map([["/", "dir"]])));
      return s;
    };
    const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
    const entry = (p: string): FileEntry | null => {
      const v = store().get(p);
      if (v === undefined) return null;
      return v === "dir" ? { name: p.split("/").pop() || "/", path: p, isDir: true } : { name: p.split("/").pop()!, path: p, isDir: false, size: v.byteLength };
    };
    const ensureParents = (p: string) => {
      for (let q = parent(p); ; q = parent(q)) {
        store().set(q, "dir");
        if (q === "/") break;
      }
    };
    const under = (p: string, base: string) => p === base || p.startsWith(base === "/" ? "/" : base + "/");
    const noCopy = config.noCopy === true || config.noCopy === "true";
    const d: StorageDriver = {
      type: "memfs",
      capabilities: { list: true, write: true, delete: true, mkdir: true, rename: !noCopy, copy: !noCopy, uploadProtocols: ["mem-direct", "proxy"] },
      async testConnection() {
        return { ok: true, message: "ok" };
      },
      async stat(p) {
        return entry(p);
      },
      async list(p) {
        if (store().get(p) !== "dir") throw new Error("not a dir");
        const entries = [...store().keys()].filter((k) => k !== p && parent(k) === p).sort().map((k) => entry(k)!);
        return { entries };
      },
      async download(p) {
        const v = store().get(p);
        if (!v || v === "dir") throw new Error("missing");
        return { kind: "response", response: new Response(v as BodyInit, { headers: { "content-length": String(v.byteLength) } }) };
      },
      async put(p, body, _opts) {
        const buf = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
        ensureParents(p);
        store().set(p, buf);
        return entry(p)!;
      },
      async delete(paths) {
        for (const p of paths) for (const k of [...store().keys()]) if (under(k, p)) store().delete(k);
      },
      async mkdir(p) {
        ensureParents(p);
        store().set(p, "dir");
      },
      async initUpload() {
        return { protocol: "mem-direct", client: {} };
      },
      async uploadAction(session, action, input) {
        ensureParents(session.objectPath);
        store().set(session.objectPath, new Uint8Array(await input.request.arrayBuffer()));
        return { response: Response.json({ ok: true }), state: "uploading", meta: { action } };
      },
      async completeUpload(session) {
        const e = entry(session.objectPath);
        if (!e || e.size !== session.size) throw new Error("size mismatch");
        return { entry: e };
      },
    };
    if (!noCopy) {
      d.rename = async (from, to) => {
        for (const k of [...store().keys()].filter((k) => under(k, from))) {
          const v = store().get(k)!;
          store().delete(k);
          store().set(to + k.slice(from.length), v);
        }
        ensureParents(to);
      };
      d.copy = async (from, to) => {
        for (const k of [...store().keys()].filter((k) => under(k, from))) store().set(to + k.slice(from.length), store().get(k)!);
        ensureParents(to);
      };
    }
    return d;
  },
};
