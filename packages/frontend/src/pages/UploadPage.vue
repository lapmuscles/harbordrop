<script setup lang="ts">
import { computed, ref, watchEffect } from "vue";
import { api, session } from "../api";
import { t, formatBytes } from "../i18n";
import { uploadFile, LocalStorageResumeStore, type ProgressInfo } from "@harbordrop/shared/upload";

const file = ref<File | null>(null);
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

const storages = computed(() => session.config?.uploadStorages ?? []);
watchEffect(() => {
  if (!storageId.value && storages.value.length) storageId.value = storages.value[0].id;
});
const expiryOptions = [0, 1, 24, 72, 168, 720].map((h) => ({ value: h, label: h === 0 ? t("upload.never") : h < 24 ? t("upload.hours", { n: h }) : t("upload.days", { n: h / 24 }) }));
const phaseText = computed(() => (progress.value ? t(`upload.${progress.value.phase}`) : ""));

function pick(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] ?? null;
}
function drop(e: DragEvent) {
  over.value = false;
  file.value = e.dataTransfer?.files?.[0] ?? null;
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
async function copy() {
  await navigator.clipboard.writeText(result.value!.url);
  copied.value = true;
}
</script>

<template>
  <div class="card">
    <h2>{{ t("upload.title") }}</h2>
    <p v-if="!storages.length" class="muted">{{ t("upload.noStorage") }}</p>
    <template v-else>
      <div class="drop" :class="{ over }" @click="($refs.input as HTMLInputElement).click()" @dragover.prevent="over = true" @dragleave="over = false" @drop.prevent="drop">
        <input ref="input" type="file" hidden @change="pick" />
        <strong v-if="file">{{ file.name }}（{{ formatBytes(file.size) }}）</strong>
        <span v-else>{{ t("upload.choose") }}</span>
      </div>
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
        <div class="grow"><label>{{ t("upload.slug") }}</label><input v-model="slug" pattern="[A-Za-z0-9_-]{3,64}" /></div>
        <div class="grow"><label>{{ t("upload.password") }}</label><input v-model="password" type="password" autocomplete="new-password" /></div>
        <div class="grow"><label>{{ t("upload.maxViews") }}</label><input v-model.number="maxViews" type="number" min="0" /></div>
      </div>
      <div class="row" style="margin-top: 16px">
        <button :disabled="!file || busy" @click="start">{{ t("upload.start") }}</button>
        <button v-if="busy" class="ghost" @click="ctrl?.abort()">{{ t("upload.cancel") }}</button>
      </div>
      <div v-if="progress" style="margin-top: 16px">
        <div class="progress"><div :style="{ width: `${Math.round(progress.fraction * 100)}%` }" /></div>
        <p class="muted">{{ phaseText }} {{ Math.round(progress.fraction * 100) }}% <span v-if="retryMsg">· {{ retryMsg }}</span></p>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <div v-if="result" class="row" style="margin-top: 12px">
        <input :value="result.url" readonly class="grow" />
        <button @click="copy">{{ copied ? t("upload.copied") : t("upload.copy") }}</button>
      </div>
    </template>
  </div>
</template>
