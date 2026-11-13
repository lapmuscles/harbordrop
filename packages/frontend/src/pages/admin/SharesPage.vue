<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../../api";
import { t, formatBytes, formatTime } from "../../i18n";

const items = ref<any[]>([]);
const total = ref(0);
async function load() {
  const r = await api.json<{ total: number; items: any[] }>("GET", "/api/admin/shares?limit=100");
  items.value = r.items;
  total.value = r.total;
}
onMounted(load);
async function remove(s: any) {
  if (!confirm(t("admin.confirmDelete"))) return;
  const deleteFile = confirm(t("admin.deleteFile") + "？");
  await api.json("DELETE", `/api/admin/shares/${encodeURIComponent(s.slug)}${deleteFile ? "?deleteFile=1" : ""}`);
  await load();
}
</script>
<template>
  <div class="card">
    <h3>{{ t("admin.shares") }}（{{ total }}）</h3>
    <table>
      <tr><th>{{ t("admin.filename") }}</th><th>{{ t("share.size") }}</th><th>{{ t("share.views") }}</th><th>{{ t("share.expiresAt") }}</th><th>{{ t("admin.createdAt") }}</th><th /></tr>
      <tr v-for="s in items" :key="s.slug">
        <td><a :href="`/f/${s.slug}`" target="_blank">{{ s.filename }}</a><div class="muted">{{ s.storageName }} · {{ s.slug }}<span v-if="s.passwordRequired"> · 🔒</span></div></td>
        <td>{{ formatBytes(s.size) }}</td>
        <td>{{ s.views }}<template v-if="s.maxViews"> / {{ s.maxViews }}</template></td>
        <td>{{ formatTime(s.expiresAt) }}</td>
        <td>{{ formatTime(s.createdAt) }}</td>
        <td><button class="danger" @click="remove(s)">{{ t("admin.delete") }}</button></td>
      </tr>
    </table>
  </div>
</template>
