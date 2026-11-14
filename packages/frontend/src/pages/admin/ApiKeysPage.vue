<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { api } from "../../api";
import { t, formatTime } from "../../i18n";
import { copyText, errMsg, fromLocalInput, toLocalInput } from "./adminui";

interface AclRule {
  storageId: number | null;
  mountId: number | null;
  pathPrefix: string;
  perms: string[];
}
interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  permissions: string[];
  enabled: boolean;
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  acl: AclRule[];
}
interface StorageLite {
  id: number;
  name: string;
}
interface MountLite {
  id: number;
  mount_path?: string;
  mountPath?: string;
}

/** 後端已知的權限（core/auth can() 的呼叫點） */
const KNOWN_PERMS = ["upload", "paste", "share", "fs.read", "fs.write", "fs.delete", "search"];
const ACL_ACTS = ["read", "list", "write", "delete", "*"];

const list = ref<ApiKey[]>([]);
const storages = ref<StorageLite[]>([]);
const mounts = ref<MountLite[]>([]);
const err = ref("");
const msg = ref("");
const loading = ref(true);

/** 建立／編輯表單；id 為空表示建立 */
const editing = ref<null | { id?: number }>(null);
const form = reactive({ name: "", perms: [] as string[], custom: "", expires: "", enabled: true, acl: [] as AclRule[] });
/** 剛建立的明文金鑰：只顯示這一次 */
const createdKey = ref<string | null>(null);
const copied = ref("");

async function load() {
  loading.value = true;
  try {
    const r = await api.json<{ items: ApiKey[] }>("GET", "/api/admin/api-keys");
    list.value = r.items;
  } catch (e) {
    err.value = errMsg(e);
  } finally {
    loading.value = false;
  }
  // ACL 下拉選單用：失敗不影響主要功能
  api
    .json<StorageLite[]>("GET", "/api/admin/storages")
    .then((x) => (storages.value = x))
    .catch(() => {});
  api
    .json<MountLite[] | { items: MountLite[] }>("GET", "/api/admin/mounts")
    .then((x) => (mounts.value = Array.isArray(x) ? x : x.items ?? []))
    .catch(() => {});
}
onMounted(load);

function mountLabel(m: MountLite) {
  return `#${m.id} ${m.mountPath ?? m.mount_path ?? ""}`;
}
function permLabel(p: string) {
  const v = t(`adminui.apiKeys.perm.${p.replace(/\./g, "_")}`);
  return v.startsWith("adminui.") ? p : `${v}（${p}）`;
}
function isExpired(k: ApiKey) {
  return k.expiresAt != null && k.expiresAt <= Date.now();
}

function add() {
  Object.assign(form, { name: "", perms: ["upload"], custom: "", expires: "", enabled: true, acl: [] });
  editing.value = {};
  createdKey.value = null;
  err.value = "";
}
function edit(k: ApiKey) {
  Object.assign(form, {
    name: k.name,
    perms: k.permissions.filter((p) => KNOWN_PERMS.includes(p)),
    custom: k.permissions.filter((p) => !KNOWN_PERMS.includes(p)).join(", "),
    expires: toLocalInput(k.expiresAt),
    enabled: k.enabled,
    acl: k.acl.map((r) => ({ ...r, perms: [...r.perms] })),
  });
  editing.value = { id: k.id };
  err.value = "";
}
function allPerms(): string[] {
  const extra = form.custom
    .split(/[,\s，]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...form.perms, ...extra])];
}
function cleanAcl(): AclRule[] {
  return form.acl.map((r) => ({
    storageId: r.storageId === null || (r.storageId as any) === "" ? null : Number(r.storageId),
    mountId: r.mountId === null || (r.mountId as any) === "" ? null : Number(r.mountId),
    pathPrefix: r.pathPrefix || "/",
    perms: r.perms,
  }));
}
function addRule() {
  form.acl.push({ storageId: null, mountId: null, pathPrefix: "/", perms: ["read"] });
}

async function save() {
  err.value = "";
  const body = { name: form.name, permissions: allPerms(), expiresAt: fromLocalInput(form.expires), enabled: form.enabled };
  try {
    if (editing.value?.id) {
      const id = editing.value.id;
      await api.json("PATCH", `/api/admin/api-keys/${id}`, body);
      await api.json("PUT", `/api/admin/api-keys/${id}/acl`, cleanAcl());
      msg.value = t("adminui.common.saved");
    } else {
      const r = await api.json<ApiKey & { key: string }>("POST", "/api/admin/api-keys", { ...body, acl: cleanAcl() });
      createdKey.value = r.key;
    }
    editing.value = null;
    await load();
  } catch (e) {
    err.value = errMsg(e);
  }
}
async function toggle(k: ApiKey) {
  err.value = "";
  try {
    await api.json("PATCH", `/api/admin/api-keys/${k.id}`, { enabled: !k.enabled });
    await load();
  } catch (e) {
    err.value = errMsg(e);
  }
}
async function remove(k: ApiKey) {
  if (!confirm(t("adminui.common.confirmDelete", { name: k.name }))) return;
  err.value = "";
  try {
    await api.json("DELETE", `/api/admin/api-keys/${k.id}`);
    await load();
  } catch (e) {
    err.value = errMsg(e);
  }
}
async function copyKey() {
  if (!createdKey.value) return;
  copied.value = (await copyText(createdKey.value)) ? t("adminui.common.copied") : t("adminui.common.copyFailed");
}
function closeCreated() {
  createdKey.value = null;
  copied.value = "";
}
</script>

<template>
  <div v-if="createdKey" class="card" style="border: 2px solid #e0a800">
    <h3>{{ t("adminui.apiKeys.createdTitle") }}</h3>
    <p class="error">{{ t("adminui.apiKeys.createdWarn") }}</p>
    <div class="row">
      <input class="grow" :value="createdKey" readonly style="font-family: monospace" @focus="($event.target as HTMLInputElement).select()" />
      <button type="button" @click="copyKey">{{ t("adminui.common.copy") }}</button>
    </div>
    <p v-if="copied" class="muted">{{ copied }}</p>
    <button type="button" class="ghost" @click="closeCreated">{{ t("adminui.common.close") }}</button>
  </div>

  <div class="card">
    <div class="row"><h3 class="grow">{{ t("adminui.apiKeys.title") }}</h3><button @click="add">{{ t("adminui.apiKeys.add") }}</button></div>
    <p v-if="msg" class="muted">{{ msg }}</p>
    <p v-if="err && !editing" class="error">{{ err }}</p>
    <p v-if="loading" class="muted">{{ t("adminui.common.loading") }}</p>
    <p v-else-if="!list.length" class="muted">{{ t("adminui.apiKeys.empty") }}</p>
    <table v-else>
      <tr>
        <th>{{ t("adminui.apiKeys.name") }}</th>
        <th>{{ t("adminui.apiKeys.prefix") }}</th>
        <th>{{ t("adminui.apiKeys.permissions") }}</th>
        <th>{{ t("adminui.apiKeys.acl") }}</th>
        <th>{{ t("adminui.apiKeys.status") }}</th>
        <th>{{ t("adminui.apiKeys.expiresAt") }}</th>
        <th>{{ t("adminui.apiKeys.lastUsedAt") }}</th>
        <th />
      </tr>
      <tr v-for="k in list" :key="k.id">
        <td>{{ k.name }}</td>
        <td><code>{{ k.prefix }}…</code></td>
        <td>{{ k.permissions.join(", ") || t("adminui.common.none") }}</td>
        <td>{{ k.acl.length || "—" }}</td>
        <td>
          <span v-if="!k.enabled" class="muted">{{ t("adminui.common.disabled") }}</span>
          <span v-else-if="isExpired(k)" class="error">{{ t("adminui.apiKeys.expired") }}</span>
          <span v-else>{{ t("adminui.common.enabled") }}</span>
        </td>
        <td>{{ k.expiresAt ? formatTime(k.expiresAt) : "—" }}</td>
        <td>{{ k.lastUsedAt ? formatTime(k.lastUsedAt) : t("adminui.common.never") }}</td>
        <td class="row">
          <button class="ghost" @click="edit(k)">{{ t("admin.edit") }}</button>
          <button class="ghost" @click="toggle(k)">{{ k.enabled ? t("adminui.common.disable") : t("adminui.common.enable") }}</button>
          <button class="danger" @click="remove(k)">{{ t("admin.delete") }}</button>
        </td>
      </tr>
    </table>
  </div>

  <form v-if="editing" class="card" @submit.prevent="save">
    <h3>{{ editing.id ? t("admin.edit") : t("adminui.apiKeys.add") }}</h3>
    <label>{{ t("adminui.apiKeys.name") }}</label>
    <input v-model="form.name" required maxlength="100" />

    <label>{{ t("adminui.apiKeys.permissions") }}</label>
    <div class="row" style="flex-wrap: wrap">
      <label v-for="p in KNOWN_PERMS" :key="p" class="row"><input v-model="form.perms" type="checkbox" :value="p" /> {{ permLabel(p) }}</label>
    </div>
    <label>{{ t("adminui.apiKeys.customPerms") }}</label>
    <input v-model="form.custom" placeholder="例如 fs.read, search" />

    <label>{{ t("adminui.apiKeys.expiresAt") }}</label>
    <input v-model="form.expires" type="datetime-local" />
    <p class="muted">{{ t("adminui.apiKeys.expiresHint") }}</p>

    <label class="row"><input v-model="form.enabled" type="checkbox" /> {{ t("adminui.common.enable") }}</label>

    <h4>{{ t("adminui.apiKeys.acl") }}</h4>
    <p class="muted">{{ t("adminui.apiKeys.aclHelp") }}</p>
    <table v-if="form.acl.length">
      <tr>
        <th>{{ t("adminui.apiKeys.aclStorage") }}</th>
        <th>{{ t("adminui.apiKeys.aclMount") }}</th>
        <th>{{ t("adminui.apiKeys.aclPath") }}</th>
        <th>{{ t("adminui.apiKeys.aclPerms") }}</th>
        <th />
      </tr>
      <tr v-for="(r, i) in form.acl" :key="i">
        <td>
          <select v-model="r.storageId">
            <option :value="null">—</option>
            <option v-for="s in storages" :key="s.id" :value="s.id">#{{ s.id }} {{ s.name }}</option>
          </select>
        </td>
        <td>
          <select v-model="r.mountId">
            <option :value="null">—</option>
            <option v-for="m in mounts" :key="m.id" :value="m.id">{{ mountLabel(m) }}</option>
          </select>
        </td>
        <td><input v-model="r.pathPrefix" placeholder="/" /></td>
        <td>
          <label v-for="a in ACL_ACTS" :key="a" class="row" style="display: inline-flex; margin-right: 6px">
            <input v-model="r.perms" type="checkbox" :value="a" /> {{ t(`adminui.apiKeys.act.${a}`) }}
          </label>
        </td>
        <td><button type="button" class="danger" @click="form.acl.splice(i, 1)">{{ t("adminui.apiKeys.aclRemove") }}</button></td>
      </tr>
    </table>
    <button type="button" class="ghost" @click="addRule">{{ t("adminui.apiKeys.aclAdd") }}</button>

    <p v-if="err" class="error">{{ err }}</p>
    <div class="row" style="margin-top: 10px">
      <button>{{ t("adminui.common.save") }}</button>
      <button type="button" class="ghost" @click="editing = null">{{ t("adminui.common.cancel") }}</button>
    </div>
  </form>
</template>
