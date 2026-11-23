<script setup lang="ts">
import { computed, ref, watchEffect } from "vue";
import { api, session } from "../api";
import { t, formatBytes } from "../i18n";
import { uploadFile, uploadFolder, LocalStorageResumeStore, newFolderGroupId, type FolderItem, type ProgressInfo } from "@harbordrop/shared/upload";
import { collectFolderFiles, filesFromDataTransfer } from "../folder";

const mode = ref<"file" | "folder">("file");
const file = ref<File | null>(null);
const folderItems = ref<FolderItem[]>([]);
const storageId = ref<number | null>(null);
const slug = ref("");
const password = ref("");
const expiresInHours = ref(0);
const maxViews = ref(0);
const over = ref(false);
const busy = ref(false);
const progress = ref<ProgressInfo | null>(null);
const retryMsg = ref("");
const error = ref("");
const result = ref<{ url: string } | null>(null);
const copied = ref(false);
let ctrl: AbortController | null = null;

// ── 資料夾模式狀態 ──
const currentFile = ref<{ item: FolderItem; index: number } | null>(null);
const overall = ref<{ loaded: number; total: number; done: number; count: number } | null>(null);
const folderDone = ref<{ item: FolderItem; url: string }[]>([]);
const folderFailed = ref<{ item: FolderItem; error: string }[]>([]);
const copiedAll = ref(false);
let folderGroupId = "";

const storages = computed(() => session.config?.uploadStorages ?? []);
watchEffect(() => {
  if (!storageId.value && storages.value.length) storageId.value = storages.value[0].id;
});
const expiryOptions = [0, 1, 24, 72, 168, 720].map((h) => ({ value: h, label: h === 0 ? t("upload.never") : h < 24 ? t("upload.hours", { n: h }) : t("upload.days", { n: h / 24 }) }));
const phaseText = computed(() => (progress.value ? t(`upload.${progress.value.phase}`) : ""));
const folderTotalSize = computed(() => folderItems.value.reduce((s, it) => s + it.file.size, 0));
const folderName = computed(() => folderItems.value[0]?.relativePath.split("/")[0] ?? "");

function pick(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] ?? null;
}
function pickFolder(e: Event) {
  const items = collectFolderFiles((e.target as HTMLInputElement).files ?? []);
  if (items.length) folderItems.value = items;
  (e.target as HTMLInputElement).value = "";
}
async function drop(e: DragEvent) {
  over.value = false;
  if (mode.value === "file") {
    file.value = e.dataTransfer?.files?.[0] ?? null;
    return;
  }
  if (!e.dataTransfer) return;
  const items = await filesFromDataTransfer(e.dataTransfer);
  if (items.length) folderItems.value = items;
}

async function start() {
  if (!file.value || !storageId.value) return;
  busy.value = true;
  error.value = "";
  result.value = null;
  retryMsg.value = "";
  ctrl = new AbortController();
  try {
    const f = file.value;
    const res = await uploadFile(api, f, {
      storageId: storageId.value,
      filename: f.name,
      mime: f.type || undefined,
      share: { slug: slug.value || undefined, password: password.value || undefined, expiresInHours: expiresInHours.value, maxViews: maxViews.value },
      signal: ctrl.signal,
      resume: new LocalStorageResumeStore(`hd-resume:${storageId.value}`),
      onProgress: (p) => (progress.value = p),
      onRetry: (r) => (retryMsg.value = t("upload.retrying", { n: r.attempt, kind: r.kind, id: r.id.slice(0, 8) })),
    });
    result.value = { url: res.url };
  } catch (e: any) {
    error.value = ctrl?.signal.aborted ? "已取消" : e.message ?? String(e);
  } finally {
    busy.value = false;
  }
}

async function runFolder(items: FolderItem[]) {
  const res = await uploadFolder(api, items, {
    storageId: storageId.value!,
    share: { password: password.value || undefined, expiresInHours: expiresInHours.value, maxViews: maxViews.value },
    groupId: folderGroupId,
    signal: ctrl!.signal,
    resume: new LocalStorageResumeStore(`hd-resume:${storageId.value}`),
    onProgress: (p) => (progress.value = p),
    onRetry: (r) => (retryMsg.value = t("upload.retrying", { n: r.attempt, kind: r.kind, id: r.id.slice(0, 8) })),
    onFileStart: (item, i) => {
      // 重試時 i 是該批內的序號，換算回整個文件夾的序號顯示
      const g = folderItems.value.indexOf(item);
      currentFile.value = { item, index: g >= 0 ? g : i };
      progress.value = null;
      retryMsg.value = "";
    },
    onFileDone: (item, _i, r) => folderDone.value.push({ item, url: r.url }),
    onFileError: (item, _i, e) => folderFailed.value.push({ item, error: e.message }),
    onOverallProgress: (o) => (overall.value = o),
  });
  if (res.aborted) error.value = "已取消";
  currentFile.value = null;
  progress.value = null;
}

async function startFolder() {
  if (!folderItems.value.length || !storageId.value) return;
  busy.value = true;
  error.value = "";
  folderDone.value = [];
  folderFailed.value = [];
  overall.value = null;
  copiedAll.value = false;
  ctrl = new AbortController();
  folderGroupId = newFolderGroupId();
  try {
    await runFolder(folderItems.value);
  } finally {
    busy.value = false;
  }
}

async function retryFailed() {
  if (!folderFailed.value.length || !storageId.value) return;
  busy.value = true;
  error.value = "";
  const items = folderFailed.value.map((f) => f.item);
  folderFailed.value = [];
  ctrl = new AbortController();
  try {
    await runFolder(items);
  } finally {
    busy.value = false;
  }
}

async function copy() {
  await navigator.clipboard.writeText(result.value!.url);
  copied.value = true;
}
async function copyOne(url: string, ev: Event) {
  await navigator.clipboard.writeText(url);
  (ev.target as HTMLButtonElement).textContent = t("upload.copied");
}
async function copyAll() {
  await navigator.clipboard.writeText(folderDone.value.map((d) => `${d.item.relativePath}\n${d.url}`).join("\n\n"));
  copiedAll.value = true;
}
</script>

<template>
  <div class="card">
    <h2>{{ t("upload.title") }}</h2>
    <p v-if="!storages.length" class="muted">{{ t("upload.noStorage") }}</p>
    <template v-else>
      <div class="row" style="margin-bottom: 12px">
        <button :class="{ ghost: mode !== 'file' }" :disabled="busy" @click="mode = 'file'">{{ t("upload.modeFile") }}</button>
        <button :class="{ ghost: mode !== 'folder' }" :disabled="busy" @click="mode = 'folder'">{{ t("upload.modeFolder") }}</button>
      </div>
      <div class="drop" :class="{ over }" @click="((mode === 'file' ? $refs.input : $refs.folderInput) as HTMLInputElement).click()" @dragover.prevent="over = true" @dragleave="over = false" @drop.prevent="drop">
        <input ref="input" type="file" hidden @change="pick" />
        <input ref="folderInput" type="file" webkitdirectory hidden @change="pickFolder" />
        <template v-if="mode === 'file'">
          <strong v-if="file">{{ file.name }}（{{ formatBytes(file.size) }}）</strong>
          <span v-else>{{ t("upload.choose") }}</span>
        </template>
        <template v-else>
          <strong v-if="folderItems.length">{{ folderName }}：{{ t("upload.folderFiles", { n: folderItems.length }) }}，{{ formatBytes(folderTotalSize) }}</strong>
          <span v-else>{{ t("upload.chooseFolder") }}</span>
        </template>
      </div>
      <ul v-if="mode === 'folder' && folderItems.length" class="filelist">
        <li v-for="it in folderItems" :key="it.relativePath">
          <span class="grow">{{ it.relativePath }}</span>
          <span class="muted">{{ formatBytes(it.file.size) }}</span>
        </li>
      </ul>
      <div class="row">
        <div class="grow">
          <label>{{ t("upload.storage") }}</label>
          <select v-model="storageId">
            <option v-for="s in storages" :key="s.id" :value="s.id">{{ s.name }}（{{ s.type }}）</option>
          </select>
        </div>
        <div class="grow">
          <label>{{ t("upload.expires") }}</label>
          <select v-model.number="expiresInHours">
            <option v-for="o in expiryOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div class="grow">
          <label>{{ t("upload.slug") }}</label>
          <input v-model="slug" pattern="[A-Za-z0-9_-]{3,64}" :disabled="mode === 'folder'" :placeholder="mode === 'folder' ? t('upload.folderSlugNote') : ''" />
        </div>
        <div class="grow"><label>{{ t("upload.password") }}</label><input v-model="password" type="password" autocomplete="new-password" /></div>
        <div class="grow"><label>{{ t("upload.maxViews") }}</label><input v-model.number="maxViews" type="number" min="0" /></div>
      </div>
      <div class="row" style="margin-top: 16px">
        <template v-if="mode === 'file'">
          <button :disabled="!file || busy" @click="start">{{ t("upload.start") }}</button>
        </template>
        <template v-else>
          <button :disabled="!folderItems.length || busy" @click="startFolder">{{ t("upload.startFolder") }}</button>
          <button v-if="folderFailed.length && !busy" class="ghost" @click="retryFailed">{{ t("upload.retryFailed") }}</button>
        </template>
        <button v-if="busy" class="ghost" @click="ctrl?.abort()">{{ t("upload.cancel") }}</button>
      </div>
      <div v-if="mode === 'file' && progress" style="margin-top: 16px">
        <div class="progress"><div :style="{ width: `${Math.round(progress.fraction * 100)}%` }" /></div>
        <p class="muted">{{ phaseText }} {{ Math.round(progress.fraction * 100) }}% <span v-if="retryMsg">· {{ retryMsg }}</span></p>
      </div>
      <div v-if="mode === 'folder' && overall" style="margin-top: 16px">
        <div class="progress"><div :style="{ width: `${overall.total ? Math.round((overall.loaded / overall.total) * 100) : 0}%` }" /></div>
        <p class="muted">{{ t("upload.overall") }} {{ overall.done }}/{{ overall.count }} · {{ formatBytes(overall.loaded) }} / {{ formatBytes(overall.total) }}</p>
        <p v-if="currentFile" class="muted">{{ t("upload.currentFile", { i: currentFile.index + 1, n: folderItems.length, name: currentFile.item.relativePath }) }}<span v-if="progress"> · {{ phaseText }} {{ Math.round(progress.fraction * 100) }}%</span><span v-if="retryMsg"> · {{ retryMsg }}</span></p>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <div v-if="mode === 'file' && result" class="row" style="margin-top: 12px">
        <input :value="result.url" readonly class="grow" />
        <button @click="copy">{{ copied ? t("upload.copied") : t("upload.copy") }}</button>
      </div>
      <div v-if="mode === 'folder' && folderDone.length" style="margin-top: 16px">
        <div class="row">
          <strong class="grow">{{ t("upload.folderDone", { n: folderDone.length }) }}</strong>
          <button class="ghost" @click="copyAll">{{ copiedAll ? t("upload.copiedAll") : t("upload.copyAll") }}</button>
        </div>
        <ul class="filelist">
          <li v-for="d in folderDone" :key="d.item.relativePath">
            <span class="grow">{{ d.item.relativePath }}</span>
            <a :href="d.url" target="_blank" rel="noopener">{{ d.url.split("/").pop() }}</a>
            <button class="ghost mini" @click="copyOne(d.url, $event)">{{ t("upload.copy") }}</button>
          </li>
        </ul>
      </div>
      <div v-if="mode === 'folder' && folderFailed.length" style="margin-top: 16px">
        <strong>{{ t("upload.folderFailed", { n: folderFailed.length }) }}</strong>
        <ul class="filelist">
          <li v-for="f in folderFailed" :key="f.item.relativePath">
            <span class="grow">{{ f.item.relativePath }}</span>
            <span class="error">{{ f.error }}</span>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>

<style scoped>
.filelist { max-height: 260px; overflow: auto; margin: 12px 0 0; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: 8px; }
.filelist li { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); font-size: 14px; }
.filelist li:last-child { border-bottom: none; }
.filelist .grow { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.mini { padding: 2px 8px; }
</style>
