<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../../api";
import { t } from "../../i18n";

interface Meta {
  id: number;
  path: string;
  headerMd: string | null;
  readmeMd: string | null;
  hasPassword: boolean;
  hidePatterns: string[];
  applyToChildren: boolean;
}
interface Form {
  id?: number;
  path: string;
  headerMd: string;
  readmeMd: string;
  password: string;
  clearPassword: boolean;
  hasPassword: boolean;
  hideText: string;
  applyToChildren: boolean;
}

const list = ref<Meta[]>([]);
const editing = ref<Form | null>(null);
const error = ref("");

async function load() {
  error.value = "";
  try {
    list.value = (await api.json<{ items: Meta[] }>("GET", "/api/admin/fs-meta")).items;
  } catch (e: any) {
    error.value = e.message;
  }
}
function add() {
  editing.value = { path: "/", headerMd: "", readmeMd: "", password: "", clearPassword: false, hasPassword: false, hideText: "", applyToChildren: true };
}
function edit(m: Meta) {
  editing.value = { id: m.id, path: m.path, headerMd: m.headerMd ?? "", readmeMd: m.readmeMd ?? "", password: "", clearPassword: false, hasPassword: m.hasPassword, hideText: m.hidePatterns.join("\n"), applyToChildren: m.applyToChildren };
}
async function save() {
  const f = editing.value!;
  const body: Record<string, unknown> = {
    path: f.path,
    headerMd: f.headerMd,
    readmeMd: f.readmeMd,
    hidePatterns: f.hideText.split("\n").map((s) => s.trim()).filter(Boolean),
    applyToChildren: f.applyToChildren,
  };
  // PATCH：password undefined = 不變，"" = 移除
  if (f.clearPassword) body.password = "";
  else if (f.password) body.password = f.password;
  try {
    if (f.id) await api.json("PATCH", `/api/admin/fs-meta/${f.id}`, body);
    else await api.json("POST", "/api/admin/fs-meta", body);
    editing.value = null;
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}
async function remove(m: Meta) {
  if (!confirm(t("admin.confirmDelete"))) return;
  try {
    await api.json("DELETE", `/api/admin/fs-meta/${m.id}`);
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}
onMounted(load);
</script>

<template>
  <div class="card">
    <div class="row">
      <h2 class="grow">{{ t("fsMeta.title") }}</h2>
      <button @click="add">{{ t("admin.add") }}</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <form v-if="editing" class="card" @submit.prevent="save">
      <label>{{ t("fsMeta.path") }}</label>
      <input v-model="editing.path" required placeholder="/local/private" />
      <label>{{ editing.id ? t("fsMeta.password") : t("fsMeta.newPassword") }}</label>
      <input v-model="editing.password" type="password" autocomplete="new-password" :disabled="editing.clearPassword" />
      <label v-if="editing.hasPassword" class="row"><input v-model="editing.clearPassword" type="checkbox" /> {{ t("fsMeta.clearPassword") }}</label>
      <label>{{ t("fsMeta.hidePatterns") }}</label>
      <textarea v-model="editing.hideText" rows="3" placeholder="*.tmp&#10;.git" />
      <label class="row"><input v-model="editing.applyToChildren" type="checkbox" /> {{ t("fsMeta.applyToChildren") }}</label>
      <label>{{ t("fsMeta.headerMd") }}</label>
      <textarea v-model="editing.headerMd" rows="3" />
      <label>{{ t("fsMeta.readmeMd") }}</label>
      <textarea v-model="editing.readmeMd" rows="4" />
      <div class="row" style="margin-top: 12px">
        <button type="submit">{{ t("admin.save") }}</button>
        <button type="button" class="ghost" @click="editing = null">{{ t("files.cancel") }}</button>
      </div>
    </form>

    <table>
      <thead>
        <tr>
          <th>{{ t("fsMeta.path") }}</th>
          <th>{{ t("fsMeta.hasPassword") }}</th>
          <th>{{ t("fsMeta.hidePatterns") }}</th>
          <th>{{ t("fsMeta.applyToChildren") }}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="m in list" :key="m.id">
          <td><RouterLink :to="'/files' + (m.path === '/' ? '' : m.path)">{{ m.path }}</RouterLink></td>
          <td>{{ m.hasPassword ? "🔒" : "-" }}</td>
          <td>{{ m.hidePatterns.join("、") || "-" }}</td>
          <td>{{ m.applyToChildren ? "✓" : "-" }}</td>
          <td class="row">
            <button class="ghost" @click="edit(m)">{{ t("admin.edit") }}</button>
            <button class="danger" @click="remove(m)">{{ t("admin.delete") }}</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
