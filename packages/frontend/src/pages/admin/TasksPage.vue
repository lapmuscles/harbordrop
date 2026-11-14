<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api } from "../../api";
import { t, formatTime } from "../../i18n";

interface Task {
  id: string;
  kind: string;
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
  progress: number;
  total: number;
  payload: any;
  result: any;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

const list = ref<Task[]>([]);
const status = ref("");
const auto = ref(true);
const error = ref("");
let timer: ReturnType<typeof setInterval> | undefined;

async function load() {
  try {
    list.value = (await api.json<{ tasks: Task[] }>("GET", `/api/admin/tasks${status.value ? `?status=${status.value}` : ""}`)).tasks;
    error.value = "";
  } catch (e: any) {
    error.value = e.message;
  }
}
async function cancel(x: Task) {
  try {
    await api.json("POST", `/api/admin/tasks/${x.id}/cancel`);
  } catch (e: any) {
    error.value = e.message;
  }
  await load();
}
async function remove(x: Task) {
  if (!confirm(t("admin.confirmDelete"))) return;
  try {
    await api.json("DELETE", `/api/admin/tasks/${x.id}`);
  } catch (e: any) {
    error.value = e.message;
  }
  await load();
}
const pct = (x: Task) => (x.status === "succeeded" ? 100 : x.total ? Math.min(100, Math.round((x.progress / x.total) * 100)) : 0);
const active = (x: Task) => x.status === "pending" || x.status === "running";
const desc = (x: Task) => x.payload?.label ?? x.payload?.description ?? x.payload?.title ?? "";

function schedule() {
  clearInterval(timer);
  if (auto.value) timer = setInterval(load, 3000);
}
watch(status, load);
watch(auto, schedule);
onMounted(() => {
  void load();
  schedule();
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="card">
    <div class="row">
      <h2 class="grow">{{ t("tasks.title") }}</h2>
      <select v-model="status" style="width: auto" :title="t('tasks.filter')">
        <option value="">{{ t("tasks.all") }}</option>
        <option v-for="s in ['pending', 'running', 'succeeded', 'failed', 'canceled']" :key="s" :value="s">{{ t(`tasks.st.${s}`) }}</option>
      </select>
      <label class="row" style="margin: 0"><input v-model="auto" type="checkbox" /> {{ t("tasks.autoRefresh") }}</label>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="!list.length" class="muted">{{ t("tasks.empty") }}</p>
    <table v-else>
      <thead>
        <tr>
          <th>{{ t("tasks.kind") }}</th>
          <th>{{ t("tasks.description") }}</th>
          <th>{{ t("tasks.status") }}</th>
          <th style="width: 180px">{{ t("tasks.progress") }}</th>
          <th>{{ t("admin.createdAt") }}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="x in list" :key="x.id">
          <td>{{ x.kind }}</td>
          <td>
            {{ desc(x) }}
            <div v-if="x.error" class="error">{{ x.error }}</div>
          </td>
          <td>{{ t(`tasks.st.${x.status}`) }}</td>
          <td>
            <div class="progress"><div :style="{ width: pct(x) + '%' }" /></div>
            <span class="muted">{{ x.progress }} / {{ x.total || "?" }}</span>
          </td>
          <td>{{ formatTime(x.createdAt) }}</td>
          <td>
            <button v-if="active(x)" class="ghost" @click="cancel(x)">{{ t("tasks.cancel") }}</button>
            <button v-else class="danger" @click="remove(x)">{{ t("tasks.delete") }}</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
