<script setup lang="ts">
import { t } from "../../i18n";
// 預留頁籤：掛載、API 金鑰、目錄 meta、備份、排程、背景工作（由各模組加入）
const tabs = [
  { to: "/admin/storages", label: t("admin.storages") },
  { to: "/admin/shares", label: t("admin.shares") },
  { to: "/admin/settings", label: t("admin.settings") },
];
</script>
<template>
  <div class="row" style="margin-bottom: 12px">
    <RouterLink v-for="x in tabs" :key="x.to" :to="x.to">{{ x.label }}</RouterLink>
  </div>
  <RouterView />
</template>
