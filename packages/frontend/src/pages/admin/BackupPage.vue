<script setup lang="ts">
import { ref } from "vue";
import { api } from "../../api";
import { t, formatTime } from "../../i18n";
import { errMsg } from "./adminui";

interface ImportResult {
  mode: "merge" | "replace";
  tables: Record<string, { inserted: number; skipped: number; updated?: number }>;
  warnings: string[];
}

const exporting = ref(false);
const exportErr = ref("");

const fileData = ref<Record<string, unknown> | null>(null);
const fileName = ref("");
const mode = ref<"merge" | "replace">("merge");
const importing = ref(false);
const importErr = ref("");
const result = ref<ImportResult | null>(null);

async function doExport() {
  exportErr.value = "";
  exporting.value = true;
  try {
    const data = await api.json<Record<string, unknown>>("GET", "/api/admin/backup/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    a.href = URL.createObjectURL(blob);
    a.download = `harbordrop-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (e) {
    exportErr.value = errMsg(e);
  } finally {
    exporting.value = false;
  }
}

async function pickFile(ev: Event) {
  importErr.value = "";
  result.value = null;
  fileData.value = null;
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (!f) return;
  fileName.value = f.name;
  try {
    const parsed = JSON.parse(await f.text());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    fileData.value = parsed;
  } catch {
    importErr.value = t("adminui.backup.badFile");
  }
}
function fileInfo(): string {
  const d = fileData.value as any;
  if (!d) return "";
  const time = d.exportedAt ?? d.createdAt;
  return t("adminui.backup.fileInfo", { version: d.version ?? "?", time: typeof time === "number" ? formatTime(time) : String(time ?? "-") });
}

async function doImport() {
  if (!fileData.value) return;
  importErr.value = "";
  result.value = null;
  if (mode.value === "replace") {
    if (!confirm(t("adminui.backup.replaceConfirm1"))) return;
    if (!confirm(t("adminui.backup.replaceConfirm2"))) return;
  }
  importing.value = true;
  try {
    result.value = await api.json<ImportResult>("POST", "/api/admin/backup/import", { mode: mode.value, data: fileData.value });
  } catch (e) {
    importErr.value = errMsg(e);
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <div class="card">
    <h3>{{ t("adminui.backup.export") }}</h3>
    <p class="muted">{{ t("adminui.backup.exportHelp") }}</p>
    <button :disabled="exporting" @click="doExport">{{ exporting ? t("adminui.backup.exporting") : t("adminui.backup.export") }}</button>
    <p v-if="exportErr" class="error">{{ exportErr }}</p>
  </div>

  <form class="card" @submit.prevent="doImport">
    <h3>{{ t("adminui.backup.import") }}</h3>
    <p class="error">⚠️ {{ t("adminui.backup.secretWarn") }}</p>
    <label>{{ t("adminui.backup.file") }}</label>
    <input type="file" accept="application/json,.json" @change="pickFile" />
    <p v-if="fileData" class="muted">{{ fileName }}：{{ fileInfo() }}</p>
    <label>{{ t("adminui.backup.mode") }}</label>
    <label class="row"><input v-model="mode" type="radio" value="merge" /> {{ t("adminui.backup.merge") }}</label>
    <label class="row"><input v-model="mode" type="radio" value="replace" /> <span class="error">{{ t("adminui.backup.replace") }}</span></label>
    <p v-if="importErr" class="error">{{ importErr }}</p>
    <button :class="mode === 'replace' ? 'danger' : ''" :disabled="!fileData || importing" style="margin-top: 10px">
      {{ importing ? t("adminui.backup.importing") : t("adminui.backup.import") }}
    </button>
  </form>

  <div v-if="result" class="card">
    <h3>{{ t("adminui.backup.importDone") }}（{{ result.mode }}）</h3>
    <div v-if="result.warnings.length">
      <h4>{{ t("adminui.backup.warnings") }}</h4>
      <ul>
        <li v-for="(w, i) in result.warnings" :key="i" class="error">{{ w }}</li>
      </ul>
    </div>
    <table>
      <tr>
        <th>{{ t("adminui.backup.table") }}</th>
        <th>{{ t("adminui.backup.inserted") }}</th>
        <th>{{ t("adminui.backup.updated") }}</th>
        <th>{{ t("adminui.backup.skipped") }}</th>
      </tr>
      <tr v-for="(v, k) in result.tables" :key="k">
        <td><code>{{ k }}</code></td>
        <td>{{ v.inserted }}</td>
        <td>{{ v.updated ?? "—" }}</td>
        <td>{{ v.skipped }}</td>
      </tr>
    </table>
  </div>
</template>
