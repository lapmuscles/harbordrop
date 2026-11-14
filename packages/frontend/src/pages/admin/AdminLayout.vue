<script setup lang="ts">
import { t } from "../../i18n";
// 預留頁籤：掛載、API 金鑰、目錄 meta、備份、排程、背景工作（由各模組加入）
const tabs = [
  { to: "/admin", label: t("site.dashboard") },
  { to: "/admin/storages", label: t("admin.storages") },
  { to: "/admin/shares", label: t("admin.shares") },
  { to: "/admin/pastes", label: t("paste.manage") },
  { to: "/admin/mounts", label: t("mounts.title") },
  { to: "/admin/fs-meta", label: t("fsMeta.title") },
  { to: "/admin/tasks", label: t("tasks.title") },
  { to: "/admin/settings", label: t("admin.settings") },
  // --- feat/admin-ui ---
  { to: "/admin/api-keys", label: t("adminui.tabs.apiKeys") },
  { to: "/admin/backup", label: t("adminui.tabs.backup") },
  { to: "/admin/jobs", label: t("adminui.tabs.jobs") },
  { to: "/admin/account", label: t("adminui.tabs.account") },
  // --- end feat/admin-ui ---
];
</script>
<template>
  <div class="row" style="margin-bottom: 12px">
    <RouterLink v-for="x in tabs" :key="x.to" :to="x.to">{{ x.label }}</RouterLink>
  </div>
  <RouterView />
</template>
