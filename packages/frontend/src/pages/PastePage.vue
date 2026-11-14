<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "../api";
import { t, formatBytes, formatTime } from "../i18n";
import { parsePasteFormat, type PasteInfo } from "@harbordrop/shared";
import { CodePreview, MarkdownPreview } from "../previews";

const route = useRoute();
const slug = String(route.params.slug);
const enc = encodeURIComponent(slug);
const info = ref<PasteInfo | null>(null);
const error = ref("");
const password = ref("");
const token = ref<string | null>(null);
const showSource = ref(false);
const copied = ref(false);

const fmt = computed(() => parsePasteFormat(info.value?.format));
const hasContent = computed(() => info.value?.content != null);
const rawUrl = (download = false) => {
  const q = new URLSearchParams();
  if (token.value) q.set("t", token.value);
  if (download) q.set("download", "1");
  const qs = q.toString();
  return `/api/pastes/${enc}/raw${qs ? `?${qs}` : ""}`;
};

async function load() {
  error.value = "";
  try {
    const q = token.value ? `?t=${encodeURIComponent(token.value)}` : "";
    info.value = await api.json<PasteInfo>("GET", `/api/pastes/${enc}${q}`);
  } catch (e: any) {
    error.value = e.message;
  }
}
onMounted(load);

async function unlock() {
  error.value = "";
  try {
    token.value = (await api.json<{ token: string }>("POST", `/api/pastes/${enc}/unlock`, { password: password.value })).token;
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}

async function copy() {
  if (!info.value?.content) return;
  await navigator.clipboard.writeText(info.value.content);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}
</script>

<template>
  <div class="card">
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="!info && !error" class="muted">{{ t("paste.loading") }}</p>
    <template v-if="info">
      <h2 style="word-break: break-all">{{ info.title || info.slug }}</h2>
      <p class="muted">
        {{ formatBytes(info.size) }} · {{ t("paste.views") }}：{{ info.views }}<template v-if="info.maxViews"> / {{ info.maxViews }}</template>
        · {{ t("paste.createdAt") }}：{{ formatTime(info.createdAt) }}
        <template v-if="info.expiresAt"> · {{ t("paste.expiresAt") }}：{{ formatTime(info.expiresAt) }}</template>
      </p>
      <form v-if="!hasContent && info.passwordRequired" class="row" @submit.prevent="unlock">
        <div class="grow"><label>{{ t("paste.needPassword") }}</label><input v-model="password" type="password" required autofocus /></div>
        <button>{{ t("paste.unlock") }}</button>
      </form>
      <template v-if="hasContent">
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <button class="ghost" @click="copy">{{ copied ? t("paste.copied") : t("paste.copyContent") }}</button>
          <a :href="rawUrl()" target="_blank" :title="t('paste.rawCounts')"><button class="ghost">{{ t("paste.raw") }}</button></a>
          <a :href="rawUrl(true)" :title="t('paste.rawCounts')"><button class="ghost">{{ t("paste.download") }}</button></a>
          <button v-if="fmt.kind === 'markdown'" class="ghost" @click="showSource = !showSource">{{ showSource ? t("paste.preview") : t("paste.source") }}</button>
        </div>
        <div style="margin-top: 16px">
          <MarkdownPreview v-if="fmt.kind === 'markdown' && !showSource" :text="info.content" />
          <CodePreview v-else-if="fmt.kind === 'code'" :text="info.content" :lang="fmt.lang" />
          <pre v-else style="white-space: pre-wrap; word-break: break-word">{{ info.content }}</pre>
        </div>
      </template>
    </template>
  </div>
</template>
