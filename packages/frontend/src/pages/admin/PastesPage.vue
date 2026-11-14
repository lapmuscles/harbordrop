<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../../api";
import { t, formatBytes, formatTime } from "../../i18n";
import { PASTE_LANGS, parsePasteFormat, type PasteAdminItem } from "@harbordrop/shared";

const items = ref<PasteAdminItem[]>([]);
const total = ref(0);
const q = ref("");
const error = ref("");
const editing = ref<null | {
  slug: string;
  title: string;
  content: string;
  kind: string;
  lang: string;
  maxViews: number;
  expiresInHours: string;
  remark: string;
  password: string;
  clearPassword: boolean;
  resetViews: boolean;
  passwordRequired: boolean;
}>(null);

async function load() {
  error.value = "";
  try {
    const r = await api.json<{ total: number; items: PasteAdminItem[] }>("GET", `/api/admin/pastes?limit=100${q.value ? `&q=${encodeURIComponent(q.value)}` : ""}`);
    items.value = r.items;
    total.value = r.total;
  } catch (e: any) {
    error.value = e.message;
  }
}
onMounted(load);

const statusOf = (p: PasteAdminItem) =>
  p.expiresAt && p.expiresAt < Date.now() ? "expired" : p.maxViews != null && p.views >= p.maxViews ? "exhausted" : "ok";

async function edit(p: PasteAdminItem) {
  const full = await api.json<PasteAdminItem & { content: string }>("GET", `/api/admin/pastes/${encodeURIComponent(p.slug)}`);
  const f = parsePasteFormat(full.format);
  editing.value = {
    slug: p.slug,
    title: full.title ?? "",
    content: full.content,
    kind: f.kind,
    lang: f.lang ?? "plaintext",
    maxViews: full.maxViews ?? 0,
    expiresInHours: "",
    remark: full.remark ?? "",
    password: "",
    clearPassword: false,
    resetViews: false,
    passwordRequired: full.passwordRequired,
  };
}

async function save() {
  const e = editing.value!;
  const body: Record<string, unknown> = {
    title: e.title || null,
    content: e.content,
    format: e.kind === "code" ? `code:${e.lang}` : e.kind,
    maxViews: Number(e.maxViews) || null,
    remark: e.remark || null,
    resetViews: e.resetViews,
  };
  if (e.expiresInHours !== "") {
    const h = Number(e.expiresInHours) || 0;
    body.expiresAt = h > 0 ? Date.now() + h * 3600_000 : null;
  }
  if (e.clearPassword) body.password = null;
  else if (e.password) body.password = e.password;
  try {
    await api.json("PATCH", `/api/admin/pastes/${encodeURIComponent(e.slug)}`, body);
    editing.value = null;
    await load();
  } catch (err: any) {
    error.value = err.message;
  }
}

async function remove(p: PasteAdminItem) {
  if (!confirm(t("admin.confirmDelete"))) return;
  await api.json("DELETE", `/api/admin/pastes/${encodeURIComponent(p.slug)}`);
  await load();
}
</script>

<template>
  <div class="card">
    <div class="row" style="align-items: center; gap: 12px">
      <h3 class="grow">{{ t("paste.manage") }}（{{ total }}）</h3>
      <RouterLink to="/paste"><button>{{ t("admin.add") }}</button></RouterLink>
    </div>
    <form class="row" style="gap: 8px" @submit.prevent="load">
      <input v-model="q" class="grow" :placeholder="t('paste.search')" />
      <button class="ghost">🔍</button>
    </form>
    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="editing" class="card" style="margin: 12px 0">
      <h4>{{ t("admin.edit") }}：{{ editing.slug }}</h4>
      <label>{{ t("paste.title") }}</label><input v-model="editing.title" />
      <div class="row" style="gap: 12px">
        <div>
          <label>{{ t("paste.format") }}</label>
          <select v-model="editing.kind">
            <option value="markdown">{{ t("paste.formatMarkdown") }}</option>
            <option value="text">{{ t("paste.formatText") }}</option>
            <option value="code">{{ t("paste.formatCode") }}</option>
          </select>
        </div>
        <div v-if="editing.kind === 'code'">
          <label>{{ t("paste.lang") }}</label>
          <select v-model="editing.lang"><option v-for="l in PASTE_LANGS" :key="l" :value="l">{{ l }}</option></select>
        </div>
        <div><label>{{ t("paste.maxViews") }}</label><input v-model.number="editing.maxViews" type="number" min="0" /></div>
        <div><label>{{ t("paste.expiresInHours") }}</label><input v-model="editing.expiresInHours" type="number" min="0" /></div>
      </div>
      <label>{{ t("paste.content") }}</label>
      <textarea v-model="editing.content" rows="10" style="width: 100%; font-family: ui-monospace, Menlo, monospace" />
      <label>{{ t("paste.remark") }}</label><input v-model="editing.remark" />
      <div class="row" style="gap: 12px; align-items: flex-end; flex-wrap: wrap">
        <div class="grow"><label>{{ t("paste.newPassword") }}</label><input v-model="editing.password" type="password" autocomplete="new-password" :disabled="editing.clearPassword" /></div>
        <label v-if="editing.passwordRequired" style="display: flex; gap: 4px; align-items: center"><input v-model="editing.clearPassword" type="checkbox" style="width: auto" />{{ t("paste.clearPassword") }}</label>
        <label style="display: flex; gap: 4px; align-items: center"><input v-model="editing.resetViews" type="checkbox" style="width: auto" />{{ t("paste.resetViews") }}</label>
      </div>
      <div class="row" style="gap: 8px; margin-top: 12px">
        <button @click="save">{{ t("admin.save") }}</button>
        <button class="ghost" @click="editing = null">✕</button>
      </div>
    </div>

    <table>
      <tr><th>{{ t("paste.title") }}</th><th>{{ t("paste.format") }}</th><th>{{ t("share.size") }}</th><th>{{ t("paste.views") }}</th><th>{{ t("paste.expiresAt") }}</th><th>{{ t("admin.createdAt") }}</th><th /></tr>
      <tr v-for="p in items" :key="p.slug">
        <td style="max-width: 320px">
          <a :href="`/p/${p.slug}`" target="_blank">{{ p.title || p.slug }}</a>
          <div class="muted" style="font-size: 12px">
            {{ p.slug }}<span v-if="p.passwordRequired"> · 🔒</span> · {{ t(`paste.status.${statusOf(p)}`) }}<span v-if="p.remark"> · {{ p.remark }}</span>
          </div>
          <div class="muted" style="font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{{ p.excerpt }}</div>
        </td>
        <td>{{ p.format }}</td>
        <td>{{ formatBytes(p.size) }}</td>
        <td>{{ p.views }}<template v-if="p.maxViews"> / {{ p.maxViews }}</template></td>
        <td>{{ formatTime(p.expiresAt) }}</td>
        <td>{{ formatTime(p.createdAt) }}</td>
        <td style="white-space: nowrap">
          <button class="ghost" @click="edit(p)">{{ t("admin.edit") }}</button>
          <button class="ghost" @click="remove(p)">{{ t("admin.delete") }}</button>
        </td>
      </tr>
    </table>
  </div>
</template>
