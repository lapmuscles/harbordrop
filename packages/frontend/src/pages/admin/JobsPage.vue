<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { api } from "../../api";
import { t, formatTime } from "../../i18n";
import { errMsg, humanInterval } from "./adminui";

interface Job {
  id: number;
  kind: string;
  name: string;
  intervalSeconds: number;
  config: Record<string, unknown>;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: string | null;
  lastMessage: string | null;
}
interface Kind {
  kind: string;
  label: string;
}

const PRESETS = [300, 900, 3600, 21600, 86400, 604800];

const list = ref<Job[]>([]);
const kinds = ref<Kind[]>([]);
const loading = ref(true);
const err = ref("");
const msg = ref("");
const running = ref<number | null>(null);

const editing = ref<null | { id?: number }>(null);
const form = reactive({ name: "", kind: "", preset: "3600" as string, seconds: 3600, configText: "{}", enabled: true });
const intervalSeconds = computed(() => (form.preset === "custom" ? Number(form.seconds) : Number(form.preset)));

async function load() {
  loading.value = true;
  try {
    const [j, k] = await Promise.all([api.json<{ items: Job[] }>("GET", "/api/admin/jobs"), api.json<{ items: Kind[] }>("GET", "/api/admin/jobs/kinds")]);
    list.value = j.items;
    kinds.value = k.items;
  } catch (e) {
    err.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function kindLabel(k: string) {
  return kinds.value.find((x) => x.kind === k)?.label ?? k;
}
function add() {
  Object.assign(form, { name: "", kind: kinds.value[0]?.kind ?? "", preset: "3600", seconds: 3600, configText: "{}", enabled: true });
  editing.value = {};
  err.value = "";
}
function edit(j: Job) {
  const isPreset = PRESETS.includes(j.intervalSeconds);
  Object.assign(form, {
    name: j.name,
    kind: j.kind,
    preset: isPreset ? String(j.intervalSeconds) : "custom",
    seconds: j.intervalSeconds,
    configText: JSON.stringify(j.config ?? {}, null, 2),
    enabled: j.enabled,
  });
  editing.value = { id: j.id };
  err.value = "";
}
async function save() {
  err.value = "";
  let config: unknown;
  try {
    config = JSON.parse(form.configText.trim() || "{}");
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
  } catch {
    err.value = t("adminui.jobs.configInvalid");
    return;
  }
  const body = { name: form.name, intervalSeconds: intervalSeconds.value, config, enabled: form.enabled };
  try {
    if (editing.value?.id) await api.json("PATCH", `/api/admin/jobs/${editing.value.id}`, body);
    else await api.json("POST", "/api/admin/jobs", { ...body, kind: form.kind });
    editing.value = null;
    msg.value = t("adminui.common.saved");
    await load();
  } catch (e) {
    err.value = errMsg(e);
  }
}
async function toggle(j: Job) {
  err.value = "";
  try {
    await api.json("PATCH", `/api/admin/jobs/${j.id}`, { enabled: !j.enabled });
    await load();
  } catch (e) {
    err.value = errMsg(e);
  }
}
async function remove(j: Job) {
  if (!confirm(t("adminui.common.confirmDelete", { name: j.name }))) return;
  err.value = "";
  try {
    await api.json("DELETE", `/api/admin/jobs/${j.id}`);
    await load();
  } catch (e) {
    err.value = errMsg(e);
  }
}
async function runNow(j: Job) {
  err.value = msg.value = "";
  running.value = j.id;
  try {
    const r = await api.json<Job>("POST", `/api/admin/jobs/${j.id}/run`);
    msg.value = `${j.name}：${t("adminui.jobs.ran", { status: r.lastStatus ?? "-" })}${r.lastMessage ? ` — ${r.lastMessage}` : ""}`;
    await load();
  } catch (e) {
    err.value = errMsg(e);
  } finally {
    running.value = null;
  }
}
</script>

<template>
  <div class="card">
    <div class="row"><h3 class="grow">{{ t("adminui.jobs.title") }}</h3><button :disabled="!kinds.length" @click="add">{{ t("adminui.jobs.add") }}</button></div>
    <p v-if="msg" class="muted">{{ msg }}</p>
    <p v-if="err && !editing" class="error">{{ err }}</p>
    <p v-if="loading" class="muted">{{ t("adminui.common.loading") }}</p>
    <p v-else-if="!list.length" class="muted">{{ t("adminui.jobs.empty") }}</p>
    <table v-else>
      <tr>
        <th>{{ t("adminui.jobs.name") }}</th>
        <th>{{ t("adminui.jobs.kind") }}</th>
        <th>{{ t("adminui.jobs.interval") }}</th>
        <th>{{ t("adminui.jobs.lastRun") }}</th>
        <th>{{ t("adminui.jobs.lastResult") }}</th>
        <th>{{ t("adminui.jobs.nextRun") }}</th>
        <th />
      </tr>
      <tr v-for="j in list" :key="j.id">
        <td>{{ j.name }}<span v-if="!j.enabled" class="muted">（{{ t("adminui.common.disabled") }}）</span></td>
        <td>{{ kindLabel(j.kind) }}</td>
        <td>{{ humanInterval(j.intervalSeconds) }}</td>
        <td>{{ formatTime(j.lastRunAt) }}</td>
        <td>
          <span v-if="!j.lastStatus" class="muted">—</span>
          <span v-else :class="j.lastStatus === 'ok' ? '' : 'error'">{{ j.lastStatus === "ok" ? "✅" : "❌" }} {{ j.lastMessage || j.lastStatus }}</span>
        </td>
        <td>{{ j.enabled ? formatTime(j.nextRunAt) : "—" }}</td>
        <td class="row">
          <button class="ghost" :disabled="running === j.id" @click="runNow(j)">{{ running === j.id ? t("adminui.jobs.running") : t("adminui.jobs.runNow") }}</button>
          <button class="ghost" @click="edit(j)">{{ t("admin.edit") }}</button>
          <button class="ghost" @click="toggle(j)">{{ j.enabled ? t("adminui.common.disable") : t("adminui.common.enable") }}</button>
          <button class="danger" @click="remove(j)">{{ t("admin.delete") }}</button>
        </td>
      </tr>
    </table>
  </div>

  <form v-if="editing" class="card" @submit.prevent="save">
    <h3>{{ editing.id ? t("admin.edit") : t("adminui.jobs.add") }}</h3>
    <label>{{ t("adminui.jobs.name") }}</label>
    <input v-model="form.name" required maxlength="100" />
    <label>{{ t("adminui.jobs.kind") }}</label>
    <select v-model="form.kind" :disabled="!!editing.id" required>
      <option v-for="k in kinds" :key="k.kind" :value="k.kind">{{ k.label }}</option>
    </select>
    <label>{{ t("adminui.jobs.interval") }}</label>
    <select v-model="form.preset">
      <option v-for="p in PRESETS" :key="p" :value="String(p)">{{ t(`adminui.jobs.presets.${p}`) }}</option>
      <option value="custom">{{ t("adminui.jobs.presets.custom") }}</option>
    </select>
    <template v-if="form.preset === 'custom'">
      <label>{{ t("adminui.jobs.intervalSeconds") }}</label>
      <input v-model.number="form.seconds" type="number" min="60" max="31622400" step="1" required />
      <p class="muted">{{ humanInterval(Number(form.seconds) || 0) }}</p>
    </template>
    <p class="muted">{{ t("adminui.jobs.cronNote") }}</p>
    <label>{{ t("adminui.jobs.config") }}</label>
    <textarea v-model="form.configText" rows="5" style="font-family: monospace" />
    <label class="row"><input v-model="form.enabled" type="checkbox" /> {{ t("adminui.jobs.enabled") }}</label>
    <p v-if="err" class="error">{{ err }}</p>
    <div class="row" style="margin-top: 10px">
      <button>{{ t("adminui.common.save") }}</button>
      <button type="button" class="ghost" @click="editing = null">{{ t("adminui.common.cancel") }}</button>
    </div>
  </form>
</template>
