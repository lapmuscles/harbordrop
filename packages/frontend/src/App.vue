<script setup lang="ts">
import { session, api, refreshSession } from "./api";
import { t } from "./i18n";
import { useRouter } from "vue-router";
const router = useRouter();
async function logout() {
  await api.json("POST", "/api/auth/logout").catch(() => {});
  await refreshSession();
  router.push("/");
}
</script>

<template>
  <nav class="top">
    <div class="container">
      <RouterLink to="/" class="brand">{{ session.config?.siteTitle ?? t("app.title") }}</RouterLink>
      <RouterLink to="/">{{ t("app.upload") }}</RouterLink>
      <template v-if="session.me?.kind === 'admin'">
        <RouterLink to="/admin">{{ t("app.admin") }}</RouterLink>
        <a href="#" @click.prevent="logout">{{ t("app.logout") }}</a>
      </template>
      <RouterLink v-else to="/login">{{ t("app.login") }}</RouterLink>
    </div>
  </nav>
  <main class="container"><RouterView /></main>
</template>
