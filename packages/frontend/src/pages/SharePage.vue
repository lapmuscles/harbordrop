<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "../api";
import { t, formatBytes, formatTime } from "../i18n";
import type { ShareInfo } from "@harbordrop/shared";
import { previewComponent } from "../previews";

const route = useRoute();
const slug = String(route.params.slug);
const info = ref<ShareInfo | null>(null);
const error = ref("");
const password = ref("");
const token = ref<string | null>(null);
const showPreview = ref(false);

onMounted(async () => {
  try {
    info.value = await api.json<ShareInfo>("GET", `/api/shares/${encodeURIComponent(slug)}`);
  } catch (e: any) {
    error.value = e.message;
  }
});

const unlocked = computed(() => info.value && (!info.value.passwordRequired || token.value));
const contentUrl = (inline: boolean) => {
  const q = new URLSearchParams();
  if (inline) q.set("inline", "1");
  if (token.value) q.set("t", token.value);
  const qs = q.toString();
  return `/api/shares/${encodeURIComponent(slug)}/content${qs ? `?${qs}` : ""}`;
};
const preview = computed(() => (info.value ? previewComponent(info.value.previewKind) : null));

async function unlock() {
  error.value = "";
  try {
    token.value = (await api.json<{ token: string }>("POST", `/api/shares/${encodeURIComponent(slug)}/unlock`, { password: password.value })).token;
  } catch (e: any) {
    error.value = e.message;
  }
}
</script>

<template>
  <div class="card">
    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="!info" class="muted">{{ t("share.loading") }}</p>
    <template v-else>
      <h2 style="word-break: break-all">{{ info.filename }}</h2>
      <p class="muted">
        {{ t("share.size") }}：{{ formatBytes(info.size) }} · {{ t("share.views") }}：{{ info.views }}<template v-if="info.maxViews"> / {{ info.maxViews }}</template>
        <template v-if="info.expiresAt"> · {{ t("share.expiresAt") }}：{{ formatTime(info.expiresAt) }}</template>
      </p>
      <p v-if="info.sha256" class="muted" style="word-break: break-all">SHA-256：{{ info.sha256 }}</p>
      <form v-if="!unlocked" class="row" @submit.prevent="unlock">
        <div class="grow"><label>{{ t("share.password") }}</label><input v-model="password" type="password" required /></div>
        <button>{{ t("share.unlock") }}</button>
      </form>
      <template v-else>
        <div class="row">
          <a :href="contentUrl(false)"><button>{{ t("share.download") }}</button></a>
          <button v-if="preview && !showPreview" class="ghost" @click="showPreview = true">預覽</button>
        </div>
        <p v-if="!preview" class="muted">{{ t("share.noPreview") }}</p>
        <div v-if="preview && showPreview" class="preview" style="margin-top: 16px">
          <component :is="preview" :src="contentUrl(true)" :info="info" />
        </div>
      </template>
    </template>
  </div>
</template>
