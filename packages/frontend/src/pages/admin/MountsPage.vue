<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../../api";
import { t, formatTime } from "../../i18n";

interface Mount {
  id: number;
  mountPath: string;
  storageId: number;
  storageName: string | null;
  rootPath: string;
  readonly: boolean;
  enabled: boolean;
  webProxy: boolean;
  cacheTtl: number;
  sort: number;
  options: Record<string, unknown>;
  updatedAt: number;
}
interface Form extends Omit<Mount, "id" | "storageName" | "options" | "updatedAt"> {
  id?: number;
  optionsText: string;
}

const list = ref<Mount[]>([]);
const storages = ref<{ id: number; name: string; type: string }[]>([]);
const editing = ref<Form | null>(null);
const error = ref("");

async function load() {
  error.value = "";
  try {
    const [m, s] = await Promise.all([api.json<{ mounts: Mount[] }>("GET", "/api/admin/mounts"), api.json<any[]>("GET", "/api/admin/storages")]);
    list.value = m.mounts;
    storages.value = s.map((x) => ({ id: x.id, name: x.name, type: x.type }));
  } catch (e: any) {
    error.value = e.message;
  }
}
function add() {
  editing.value = { mountPath: "/", storageId: storages.value[0]?.id ?? 0, rootPath: "/", readonly: false, enabled: true, webProxy: false, cacheTtl: 0, sort: 0, optionsText: "{}" };
}
function edit(m: Mount) {
  const { storageName, options, updatedAt, ...rest } = m;
  editing.value = { ...rest, optionsText: JSON.stringify(options ?? {}, null, 2) };
}
async function save() {
  const f = editing.value!;
  let options: unknown;
  try {
    options = JSON.parse(f.optionsText || "{}");
    if (!options || typeof options !== "object" || Array.isArray(options)) throw 0;
  } catch {
    error.value = t("mounts.badJson");
    return;
  }
  const { id, optionsText, ...body } = f;
  try {
    if (id) await api.json("PATCH", `/api/admin/mounts/${id}`, { ...body, options });
    else await api.json("POST", "/api/admin/mounts", { ...body, options });
    editing.value = null;
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}
async function remove(m: Mount) {
  if (!confirm(t("admin.confirmDelete"))) return;
  try {
    await api.json("DELETE", `/api/admin/mounts/${m.id}`);
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}
async function toggle(m: Mount, k: "enabled" | "readonly") {
  try {
    await api.json("PATCH", `/api/admin/mounts/${m.id}`, { [k]: !m[k] });
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}
const filesLink = (p: string) => "/files" + (p === "/" ? "" : p);
onMounted(load);
</script>

<template>
  <div class="card">
    <div class="row">
      <h2 class="grow">{{ t("mounts.title") }}</h2>
      <button @click="add">{{ t("admin.add") }}</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <form v-if="editing" class="card" @submit.prevent="save">
      <div class="row">
        <div class="grow"><label>{{ t("mounts.mountPath") }}</label><input v-model="editing.mountPath" required placeholder="/local" /></div>
        <div class="grow">
          <label>{{ t("mounts.storage") }}</label>
          <select v-model.number="editing.storageId">
            <option v-for="s in storages" :key="s.id" :value="s.id">{{ s.name }}（{{ s.type }}）</option>
          </select>
        </div>
        <div class="grow"><label>{{ t("mounts.rootPath") }}</label><input v-model="editing.rootPath" placeholder="/" /></div>
      </div>
      <div class="row">
        <div><label>{{ t("mounts.cacheTtl") }}</label><input v-model.number="editing.cacheTtl" type="number" min="0" /></div>
        <div><label>{{ t("mounts.sort") }}</label><input v-model.number="editing.sort" type="number" /></div>
      </div>
      <div class="row" style="margin-top: 8px">
        <label class="row"><input v-model="editing.enabled" type="checkbox" /> {{ t("mounts.enabled") }}</label>
        <label class="row"><input v-model="editing.readonly" type="checkbox" /> {{ t("mounts.readonly") }}</label>
        <label class="row"><input v-model="editing.webProxy" type="checkbox" /> {{ t("mounts.webProxy") }}</label>
      </div>
      <label>{{ t("mounts.options") }}</label>
      <textarea v-model="editing.optionsText" rows="3" style="font-family: monospace" />
      <div class="row" style="margin-top: 12px">
        <button type="submit">{{ t("admin.save") }}</button>
        <button type="button" class="ghost" @click="editing = null">{{ t("files.cancel") }}</button>
      </div>
    </form>

    <table>
      <thead>
        <tr>
          <th>{{ t("mounts.mountPath") }}</th>
          <th>{{ t("mounts.storage") }}</th>
          <th>{{ t("mounts.rootPath") }}</th>
          <th>{{ t("mounts.enabled") }}</th>
          <th>{{ t("mounts.readonly") }}</th>
          <th>{{ t("mounts.sort") }}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="m in list" :key="m.id">
          <td><RouterLink :to="filesLink(m.mountPath)">{{ m.mountPath }}</RouterLink></td>
          <td>{{ m.storageName ?? m.storageId }}</td>
          <td>{{ m.rootPath }}</td>
          <td><input type="checkbox" :checked="m.enabled" @change="toggle(m, 'enabled')" /></td>
          <td><input type="checkbox" :checked="m.readonly" @change="toggle(m, 'readonly')" /></td>
          <td>{{ m.sort }}</td>
          <td class="row">
            <button class="ghost" @click="edit(m)">{{ t("admin.edit") }}</button>
            <button class="danger" @click="remove(m)">{{ t("admin.delete") }}</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p class="muted" v-if="list.length">{{ t("files.modified") }}：{{ formatTime(Math.max(...list.map((m) => m.updatedAt))) }}</p>
  </div>
</template>
