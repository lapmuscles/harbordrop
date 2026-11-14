import { reactive } from "vue";
import { HdApiError, LocalStorageResumeStore, type ProgressInfo, type UploadHooks } from "@harbordrop/shared/upload";
import { fsUpload, type ProxyPut } from "./upload";
import { api } from "../api";

/** 檔案總管前端 API（/api/fs/*）。目錄解鎖權杖存在 sessionStorage，以 X-Fs-Token 或 ?fsToken= 帶上 */
export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  modifiedAt: number | null;
  mime: string | null;
  mount?: boolean;
  hidden?: boolean;
  downloadUrl?: string;
}
export interface FsListResponse {
  path: string;
  entries: FsEntry[];
  cursor: string | null;
  mount: { id: number; path: string; readonly: boolean } | null;
  headerMd: string | null;
  readmeMd: string | null;
}
export interface FsMetaResponse {
  path: string;
  passwordRequired: boolean;
  passwordPath: string | null;
  unlocked: boolean;
  headerMd: string | null;
  readmeMd: string | null;
}
export interface TransferResponse {
  ok: boolean;
  done: number;
  queued: number;
  taskId: string | null;
}

const TOKEN_KEY = "hd-fs-tokens";
function loadTokens(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? "{}");
  } catch {
    return {};
  }
}
export const fsTokens = reactive<Record<string, string>>(loadTokens());
export function saveToken(path: string, token: string) {
  fsTokens[path] = token;
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(fsTokens));
}
export const tokenHeader = (): Record<string, string> => {
  const v = Object.values(fsTokens).join(",");
  return v ? { "X-Fs-Token": v } : {};
};
const q = (o: Record<string, string | number | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

export function downloadUrl(path: string, inline = false): string {
  const tok = Object.values(fsTokens).join(",");
  return `/api/fs/download?${q({ path, inline: inline ? 1 : undefined, fsToken: tok || undefined })}`;
}

const j = <T>(method: string, path: string, body?: unknown) => api.json<T>(method, path, body, tokenHeader());

export const fs = {
  list: (path: string, cursor?: string) => j<FsListResponse>("GET", `/api/fs/list?${q({ path, cursor })}`),
  get: (path: string) => j<FsEntry>("GET", `/api/fs/get?${q({ path })}`),
  meta: (path: string) => j<FsMetaResponse>("GET", `/api/fs/meta?${q({ path })}`),
  unlock: async (path: string, password: string) => {
    const r = await j<{ ok: boolean; token: string | null; path: string | null }>("POST", "/api/fs/unlock", { path, password });
    if (r.token && r.path) saveToken(r.path, r.token);
    return r;
  },
  mkdir: (path: string) => j<{ ok: boolean; path: string }>("POST", "/api/fs/mkdir", { path }),
  rename: (path: string, name: string) => j<{ ok: boolean; path: string }>("POST", "/api/fs/rename", { path, name }),
  remove: (paths: string[]) => j<{ ok: boolean; deleted: number }>("POST", "/api/fs/delete", { paths }),
  copy: (paths: string[], dst: string) => j<TransferResponse>("POST", "/api/fs/copy", { paths, dst }),
  move: (paths: string[], dst: string) => j<TransferResponse>("POST", "/api/fs/move", { paths, dst }),
  share: (path: string, share: Record<string, unknown>) => j<{ url: string; share: any }>("POST", "/api/fs/share", { path, share }),
};

export const isPasswordError = (e: unknown) => e instanceof HdApiError && e.code === "password_required";

// ───────── 上傳 ─────────
/** 經後端 PUT（XHR 才有上傳進度） */
const xhrPut: ProxyPut = (url, file, headers, hooks) =>
  new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    x.withCredentials = true;
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    if ((file as File).type) x.setRequestHeader("Content-Type", (file as File).type);
    x.upload.onprogress = (e) => hooks.onProgress?.({ phase: "uploading", fraction: e.total ? e.loaded / e.total : 0, loaded: e.loaded, total: file.size });
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve();
      let msg = `HTTP ${x.status}`;
      let code = "http_error";
      try {
        const d = JSON.parse(x.responseText);
        msg = d?.error?.message ?? msg;
        code = d?.error?.code ?? code;
      } catch {}
      reject(new HdApiError(x.status, code, msg));
    };
    x.onerror = () => reject(new Error("網路錯誤"));
    x.onabort = () => reject(new DOMException("aborted", "AbortError"));
    hooks.signal?.addEventListener("abort", () => x.abort());
    x.send(file);
  });

/** 上傳一個檔案到目錄 dir */
export async function uploadToDir(dir: string, file: File, hooks: UploadHooks): Promise<void> {
  await fsUpload(api, dir, file, file.name, { ...hooks, headers: tokenHeader(), proxyPut: xhrPut });
}

// ───────── 上傳佇列 ─────────
export interface QueueItem {
  id: number;
  file: File;
  dir: string;
  status: "waiting" | "running" | "done" | "error" | "canceled";
  progress: ProgressInfo | null;
  speed: number;
  error: string;
  retryMsg: string;
  ctrl?: AbortController;
}
let seq = 0;
export const queue = reactive<{ items: QueueItem[]; concurrency: number }>({ items: [], concurrency: 2 });
const listeners = new Set<(dir: string) => void>();
export function onUploaded(fn: (dir: string) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function enqueue(dir: string, files: File[]) {
  for (const file of files) queue.items.push({ id: ++seq, file, dir, status: "waiting", progress: null, speed: 0, error: "", retryMsg: "" });
  pump();
}
export function retryItem(it: QueueItem) {
  Object.assign(it, { status: "waiting", error: "", retryMsg: "", progress: null, speed: 0 });
  pump();
}
export function cancelItem(it: QueueItem) {
  if (it.status === "running") it.ctrl?.abort();
  else if (it.status === "waiting") it.status = "canceled";
}
export function clearFinished() {
  queue.items = queue.items.filter((i) => i.status === "waiting" || i.status === "running");
}

function pump() {
  const running = queue.items.filter((i) => i.status === "running").length;
  const next = queue.items.filter((i) => i.status === "waiting").slice(0, Math.max(0, queue.concurrency - running));
  for (const it of next) void run(it);
}

async function run(it0: QueueItem) {
  const it = queue.items.find((i) => i.id === it0.id) ?? it0; // 取 reactive 代理
  it.status = "running";
  it.ctrl = new AbortController();
  let lastT = performance.now();
  let lastB = 0;
  try {
    await uploadToDir(it.dir, it.file, {
      signal: it.ctrl.signal,
      resume: new LocalStorageResumeStore(`hd-fs-resume:${it.dir}`),
      onProgress: (p) => {
        it.progress = p;
        const loaded = p.loaded ?? p.fraction * p.total;
        const now = performance.now();
        if (now - lastT >= 500) {
          it.speed = Math.max(0, ((loaded - lastB) * 1000) / (now - lastT));
          lastT = now;
          lastB = loaded;
        }
      },
      onRetry: (r) => (it.retryMsg = `第 ${r.attempt} 次重試（${r.kind}）`),
    });
    it.status = "done";
    it.speed = 0;
    listeners.forEach((f) => f(it.dir));
  } catch (e: any) {
    it.status = it.ctrl.signal.aborted ? "canceled" : "error";
    it.error = it.status === "canceled" ? "" : e?.message ?? String(e);
  } finally {
    pump();
  }
}
