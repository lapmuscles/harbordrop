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
