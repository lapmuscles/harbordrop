<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { api, refreshSession } from "../../api";
import { t } from "../../i18n";
import type { StorageDto, StorageTypeInfo } from "@harbordrop/shared";

const types = ref<StorageTypeInfo[]>([]);
const list = ref<StorageDto[]>([]);
const editing = ref<null | { id?: number; secretsSet: string[] }>(null);
const form = reactive<{ name: string; type: string; enabled: boolean; isDefault: boolean; allowAnonymousUpload: boolean; remark: string; config: Record<string, any> }>({
  name: "",
  type: "",
  enabled: true,
  isDefault: false,
  allowAnonymousUpload: false,
  remark: "",
  config: {},
});
const msg = ref("");
const err = ref("");
const typeInfo = computed(() => types.value.find((x) => x.type === form.type));

async function load() {
  [types.value, list.value] = await Promise.all([api.json<StorageTypeInfo[]>("GET", "/api/admin/storage-types"), api.json<StorageDto[]>("GET", "/api/admin/storages")]);
}
onMounted(load);

function resetConfig() {
  form.config = Object.fromEntries((typeInfo.value?.fields ?? []).map((f) => [f.key, f.type === "secret" ? "" : f.default ?? ""]));
}
function add() {
  Object.assign(form, { name: "", type: types.value[0]?.type ?? "", enabled: true, isDefault: false, allowAnonymousUpload: false, remark: "" });
  resetConfig();
  editing.value = { secretsSet: [] };
}
function edit(s: StorageDto) {
  Object.assign(form, { name: s.name, type: s.type, enabled: s.enabled, isDefault: s.isDefault, allowAnonymousUpload: s.allowAnonymousUpload, remark: s.remark ?? "" });
  resetConfig();
  Object.assign(form.config, s.config);
  editing.value = { id: s.id, secretsSet: s.secretsSet };
}
async function persist(): Promise<number> {
  const body = { ...form, config: { ...form.config } };
  let id = editing.value?.id;
  if (id) await api.json("PUT", `/api/admin/storages/${id}`, body);
  else id = (await api.json<StorageDto>("POST", "/api/admin/storages", body)).id;
  return id;
}
async function save() {
  err.value = "";
  try {
    await persist();
    editing.value = null;
    await load();
    await refreshSession();
  } catch (e: any) {
    err.value = e.message;
  }
}

// --- feat/admin-ui：OAuth 授權（OneDrive / Google Drive 等 driver.oauth） ---
const hasOAuth = computed(() => !!(typeInfo.value as (StorageTypeInfo & { oauth?: boolean }) | undefined)?.oauth);
const oauthRedirect = ref("");
const oauthBusy = ref(false);
/** 預設的 redirect URI（後端若設定 PUBLIC_URL，實際值以 start?format=json 回傳為準） */
const redirectUri = computed(() => oauthRedirect.value || `${location.origin}/api/admin/storages/oauth/${encodeURIComponent(form.type)}/callback`);
function oauthProvider(): string {
  return typeInfo.value?.label ?? form.type;
}
async function authorize() {
  err.value = "";
  oauthBusy.value = true;
  try {
    // 先儲存（授權需要 storageId 與已儲存的 client_id／secret）
    const id = await persist();
    editing.value = { id, secretsSet: editing.value?.secretsSet ?? [] };
    const r = await api.json<{ url: string; redirectUri: string }>("GET", `/api/admin/storages/oauth/${encodeURIComponent(form.type)}/start?storageId=${id}&format=json`);
    oauthRedirect.value = r.redirectUri;
    location.href = r.url;
  } catch (e: any) {
    err.value = e.message;
    oauthBusy.value = false;
  }
}
// --- end feat/admin-ui ---
async function remove(s: StorageDto) {
  if (!confirm(t("admin.confirmDelete"))) return;
  await api.json("DELETE", `/api/admin/storages/${s.id}`);
  await load();
}
async function test(s: StorageDto) {
  const r = await api.json<{ ok: boolean; message: string }>("POST", `/api/admin/storages/${s.id}/test`);
  msg.value = `${s.name}：${r.ok ? "✅" : "❌"} ${r.message}`;
}
</script>

<template>
  <div class="card">
    <div class="row"><h3 class="grow">{{ t("admin.storages") }}</h3><button @click="add">{{ t("admin.add") }}</button></div>
    <p v-if="msg" class="muted">{{ msg }}</p>
    <table>
      <tr><th>{{ t("admin.name") }}</th><th>{{ t("admin.type") }}</th><th>{{ t("admin.enabled") }}</th><th /></tr>
      <tr v-for="s in list" :key="s.id">
        <td>{{ s.name }}<span v-if="s.isDefault" class="muted">（{{ t("admin.isDefault") }}）</span></td>
        <td>{{ types.find((x) => x.type === s.type)?.label ?? s.type }}</td>
        <td>{{ s.enabled ? "✓" : "—" }}</td>
        <td class="row">
          <button class="ghost" @click="test(s)">{{ t("admin.test") }}</button>
          <button class="ghost" @click="edit(s)">{{ t("admin.edit") }}</button>
          <button class="danger" @click="remove(s)">{{ t("admin.delete") }}</button>
        </td>
      </tr>
    </table>
  </div>

  <form v-if="editing" class="card" @submit.prevent="save">
    <h3>{{ editing.id ? t("admin.edit") : t("admin.add") }}</h3>
    <label>{{ t("admin.name") }}</label><input v-model="form.name" required />
    <label>{{ t("admin.type") }}</label>
    <select v-model="form.type" :disabled="!!editing.id" @change="resetConfig">
      <option v-for="x in types" :key="x.type" :value="x.type">{{ x.label }}</option>
    </select>
    <p v-if="typeInfo?.description" class="muted">{{ typeInfo.description }}</p>
    <template v-for="f in typeInfo?.fields ?? []" :key="f.key">
      <label>{{ f.label }}<span v-if="f.required"> *</span></label>
      <select v-if="f.type === 'select'" v-model="form.config[f.key]">
        <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
      <input v-else-if="f.type === 'boolean'" v-model="form.config[f.key]" type="checkbox" />
      <input v-else-if="f.type === 'number'" v-model.number="form.config[f.key]" type="number" />
      <textarea v-else-if="f.type === 'textarea'" v-model="form.config[f.key]" rows="4" />
      <input
        v-else
        v-model="form.config[f.key]"
        :type="f.type === 'secret' ? 'password' : 'text'"
        :placeholder="f.type === 'secret' && editing.secretsSet.includes(f.key) ? t('admin.secretKept') : f.placeholder"
        autocomplete="off"
      />
      <p v-if="f.help" class="muted">{{ f.help }}</p>
    </template>
    <div class="row" style="margin-top: 10px">
      <label class="row"><input v-model="form.enabled" type="checkbox" /> {{ t("admin.enabled") }}</label>
      <label class="row"><input v-model="form.isDefault" type="checkbox" /> {{ t("admin.isDefault") }}</label>
      <label class="row"><input v-model="form.allowAnonymousUpload" type="checkbox" /> {{ t("admin.allowAnon") }}</label>
    </div>
    <div v-if="hasOAuth" class="card" style="margin-top: 10px">
      <p class="muted">{{ t("adminui.oauth.redirectUri", { provider: oauthProvider() }) }}</p>
      <input :value="redirectUri" readonly style="font-family: monospace" @focus="($event.target as HTMLInputElement).select()" />
      <p v-if="!editing.id" class="muted">{{ t("adminui.oauth.saveFirst") }}</p>
      <button type="button" style="margin-top: 8px" :disabled="oauthBusy" @click="authorize">
        {{ oauthBusy ? t("adminui.oauth.starting") : t("adminui.oauth.authorize") }}
      </button>
    </div>
    <p v-if="err" class="error">{{ err }}</p>
    <div class="row"><button>{{ t("admin.save") }}</button><button type="button" class="ghost" @click="editing = null">{{ t("upload.cancel") }}</button></div>
  </form>
</template>
