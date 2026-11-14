<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../../api";
import { t, formatBytes, formatTime } from "../../i18n";
import { layoutBars } from "./barchart";

interface Stats {
  shares: number;
  pastes: number;
  storages: number;
  mounts: number;
  totalUploadBytes: number;
  runningTasks: number;
  pendingTasks: number;
  dailyUploads: { date: string; count: number; bytes: number }[];
  recentShares: { id: number; slug: string; filename: string; size: number; createdAt: number; views: number; createdBy: string }[];
}

const stats = ref<Stats | null>(null);
const err = ref("");
const loading = ref(false);
async function load() {
  loading.value = true;
  err.value = "";
  try {
    stats.value = await api.json<Stats>("GET", `/api/admin/stats?tzOffset=${new Date().getTimezoneOffset()}`);
  } catch (e: any) {
    err.value = t("site.loadFailed", { msg: e?.message ?? String(e) });
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const W = 560;
const H = 180;
const chart = computed(() =>
  layoutBars((stats.value?.dailyUploads ?? []).map((d) => ({ label: d.date.slice(5).replace("-", "/"), value: d.count })), { width: W, height: H }),
);
const cards = computed(() => {
  const s = stats.value;
  if (!s) return [];
  return [
    { label: t("site.shares"), value: String(s.shares), to: "/admin/shares" },
    { label: t("site.pastes"), value: String(s.pastes), to: "/admin/pastes" },
    { label: t("site.storages"), value: String(s.storages), to: "/admin/storages" },
    { label: t("site.mounts"), value: String(s.mounts) },
    { label: t("site.totalBytes"), value: formatBytes(s.totalUploadBytes) },
    { label: t("site.runningTasks"), value: String(s.runningTasks), sub: s.pendingTasks ? t("site.pendingTasks", { n: s.pendingTasks }) : "" },
  ];
});
</script>

<template>
  <div>
    <div class="row" style="justify-content: space-between; margin-bottom: 12px">
      <h3 style="margin: 0">{{ t("site.dashboard") }}</h3>
      <button type="button" :disabled="loading" @click="load">{{ t("site.refresh") }}</button>
    </div>
    <p v-if="err" class="muted" style="color: var(--err)">{{ err }}</p>
    <template v-if="stats">
      <div class="stat-grid">
        <component :is="c.to ? 'RouterLink' : 'div'" v-for="c in cards" :key="c.label" :to="c.to" class="card" style="text-decoration: none; color: inherit">
          <div class="muted">{{ c.label }}</div>
          <div class="stat-value">{{ c.value }}</div>
          <div v-if="c.sub" class="muted">{{ c.sub }}</div>
        </component>
      </div>

      <div class="card">
        <h4 style="margin-top: 0">{{ t("site.dailyUploads") }}</h4>
        <svg class="bar-chart" :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="t('site.dailyUploads')">
          <g v-for="tk in chart.ticks" :key="tk.y">
            <line x1="32" :x2="W" :y1="tk.y" :y2="tk.y" stroke="#e2e8f0" />
            <text x="26" :y="tk.y + 4" text-anchor="end">{{ tk.value }}</text>
          </g>
          <g v-for="(b, i) in chart.bars" :key="b.label">
            <rect class="bar" :x="b.x" :y="b.y" :width="b.w" :height="Math.max(b.h, b.value ? 1 : 0)" rx="3">
              <title>{{ t("site.chartLabel", { date: stats.dailyUploads[i].date, n: b.value, bytes: formatBytes(stats.dailyUploads[i].bytes) }) }}</title>
            </rect>
            <text v-if="b.value" :x="b.x + b.w / 2" :y="b.y - 4" text-anchor="middle">{{ b.value }}</text>
            <text :x="b.x + b.w / 2" :y="H - 6" text-anchor="middle">{{ b.label }}</text>
          </g>
        </svg>
      </div>

      <div class="card">
        <h4 style="margin-top: 0">{{ t("site.recentShares") }}</h4>
        <p v-if="!stats.recentShares.length" class="muted">{{ t("site.noShares") }}</p>
        <table v-else style="width: 100%; border-collapse: collapse; font-size: 14px">
          <thead>
            <tr style="text-align: left">
              <th>{{ t("site.filename") }}</th>
              <th>{{ t("site.size") }}</th>
              <th>{{ t("site.views") }}</th>
              <th>{{ t("site.by") }}</th>
              <th>{{ t("site.createdAt") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in stats.recentShares" :key="s.id" style="border-top: 1px solid var(--line)">
              <td style="word-break: break-all"><a :href="`/f/${s.slug}`" target="_blank" rel="noopener">{{ s.filename }}</a></td>
              <td>{{ formatBytes(s.size) }}</td>
              <td>{{ s.views }}</td>
              <td>{{ s.createdBy === "anon" ? t("site.anon") : s.createdBy }}</td>
              <td>{{ formatTime(s.createdAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
