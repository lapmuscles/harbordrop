<script setup lang="ts">
import { computed, ref } from "vue";
import { api, session } from "../api";
import { t } from "../i18n";
import { PASTE_LANGS, type PasteCreateInput, type PasteInfo } from "@harbordrop/shared";
import { CodePreview, MarkdownPreview } from "../previews";

const cfg = computed(() => (session.config ?? {}) as Record<string, any>);
const allowed = computed(() => session.me?.kind === "admin" || session.me?.kind === "apikey" || !!cfg.value.allowAnonymousPaste);
const maxBytes = computed(() => Number(cfg.value.pasteMaxBytes) || 0);

const title = ref("");
const content = ref("");
const kind = ref<"markdown" | "text" | "code">("markdown");
const lang = ref("plaintext");
const slug = ref("");
const password = ref("");
const expiresInHours = ref(0);
const maxViews = ref(0);
const remark = ref("");
const showPreview = ref(false);
const busy = ref(false);
const error = ref("");
const result = ref<{ paste: PasteInfo; url: string } | null>(null);
const copied = ref(false);

const bytes = computed(() => new TextEncoder().encode(content.value).byteLength);
const tooLarge = computed(() => maxBytes.value > 0 && bytes.value > maxBytes.value);
const format = computed(() => (kind.value === "code" ? `code:${lang.value}` : kind.value));
const fullUrl = computed(() => (result.value ? new URL(result.value.url, location.origin).href : ""));

async function submit() {
  error.value = "";
  busy.value = true;
  try {
    const body: PasteCreateInput = {
      content: content.value,
      format: format.value,
      title: title.value || undefined,
      slug: slug.value || undefined,
      password: password.value || undefined,
      expiresInHours: Number(expiresInHours.value) || 0,
      maxViews: Number(maxViews.value) || 0,
      remark: remark.value || undefined,
    };
    result.value = await api.json("POST", "/api/pastes", body);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function copyLink() {
  await navigator.clipboard.writeText(fullUrl.value);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}
function reset() {
  result.value = null;
  content.value = title.value = slug.value = password.value = remark.value = "";
}
</script>

<template>
  <div class="card">
    <h2>{{ t("paste.newTitle") }}</h2>
    <p v-if="!allowed" class="muted">{{ t("paste.notAllowed") }} <RouterLink to="/login?next=/paste">{{ t("app.login") }}</RouterLink></p>
    <template v-else-if="result">
      <p>{{ t("paste.created") }}</p>
      <div class="row" style="gap: 8px; align-items: center">
        <input :value="fullUrl" readonly class="grow" @focus="($event.target as HTMLInputElement).select()" />
        <button @click="copyLink">{{ copied ? t("paste.copied") : t("paste.copyLink") }}</button>
        <RouterLink :to="result.url"><button class="ghost">{{ t("paste.preview") }}</button></RouterLink>
      </div>
      <button class="ghost" style="margin-top: 12px" @click="reset">{{ t("paste.newTitle") }}</button>
    </template>
    <form v-else @submit.prevent="submit">
      <label>{{ t("paste.title") }}</label>
      <input v-model="title" maxlength="200" />
      <div class="row" style="gap: 12px; margin-top: 8px">
        <div>
          <label>{{ t("paste.format") }}</label>
          <select v-model="kind">
            <option value="markdown">{{ t("paste.formatMarkdown") }}</option>
            <option value="text">{{ t("paste.formatText") }}</option>
            <option value="code">{{ t("paste.formatCode") }}</option>
          </select>
        </div>
        <div v-if="kind === 'code'">
          <label>{{ t("paste.lang") }}</label>
          <select v-model="lang"><option v-for="l in PASTE_LANGS" :key="l" :value="l">{{ l }}</option></select>
        </div>
        <div class="grow" />
        <button type="button" class="ghost" style="align-self: flex-end" @click="showPreview = !showPreview">{{ showPreview ? t("paste.edit") : t("paste.preview") }}</button>
      </div>
      <label style="margin-top: 8px">{{ t("paste.content") }}</label>
      <textarea v-if="!showPreview" v-model="content" rows="16" required spellcheck="false" style="width: 100%; font-family: ui-monospace, Menlo, monospace" />
      <div v-else style="min-height: 200px; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px">
        <MarkdownPreview v-if="kind === 'markdown'" :text="content" />
        <CodePreview v-else-if="kind === 'code'" :text="content" :lang="lang" />
        <pre v-else style="white-space: pre-wrap">{{ content }}</pre>
      </div>
      <p class="muted" :class="{ error: tooLarge }" style="font-size: 13px">
        {{ maxBytes ? t("paste.bytes", { n: bytes, max: maxBytes }) : `${bytes}` }}<template v-if="tooLarge"> · {{ t("paste.tooLarge") }}</template>
      </p>
      <div class="row" style="gap: 12px; flex-wrap: wrap">
        <div class="grow"><label>{{ t("paste.slug") }}</label><input v-model="slug" pattern="[A-Za-z0-9_\-]{3,64}" /></div>
        <div class="grow"><label>{{ t("paste.password") }}</label><input v-model="password" type="password" autocomplete="new-password" /></div>
        <div><label>{{ t("paste.expires") }}</label><input v-model.number="expiresInHours" type="number" min="0" /></div>
        <div><label>{{ t("paste.maxViews") }}</label><input v-model.number="maxViews" type="number" min="0" /></div>
      </div>
      <label style="margin-top: 8px">{{ t("paste.remark") }}</label>
      <input v-model="remark" maxlength="500" />
      <p v-if="error" class="error">{{ error }}</p>
      <button style="margin-top: 12px" :disabled="busy || tooLarge || !content">{{ busy ? t("paste.creating") : t("paste.create") }}</button>
    </form>
  </div>
</template>
