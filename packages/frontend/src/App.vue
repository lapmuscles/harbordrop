<script setup lang="ts">
import { computed, watch } from "vue";
import { session, api, refreshSession } from "./api";
import { t, setLocale } from "./i18n";
import { useRouter } from "vue-router";
import SiteMarkdown from "./components/SiteMarkdown.vue";
const router = useRouter();
const title = computed(() => session.site?.siteTitle || session.config?.siteTitle || t("app.title"));
const allowPaste = computed(() => session.me?.kind === "admin" || !!session.site?.allowAnonymousPaste || !!(session.config as any)?.allowAnonymousPaste);
watch(title, (v) => (document.title = v), { immediate: true });
watch(
  () => session.site?.defaultLanguage,
  (l) => l && setLocale(l),
  { immediate: true },
);
async function logout() {
  await api.json("POST", "/api/auth/logout").catch(() => {});
  await refreshSession();
  router.push("/");
}
</script>

<template>
  <nav class="top">
    <div class="container">
      <RouterLink to="/" class="brand">{{ title }}</RouterLink>
      <RouterLink to="/">{{ t("app.upload") }}</RouterLink>
      <RouterLink to="/files">{{ t("files.nav") }}</RouterLink>
      <RouterLink v-if="allowPaste" to="/paste">{{ t("paste.nav") }}</RouterLink>
      <template v-if="session.me?.kind === 'admin'">
        <RouterLink to="/admin">{{ t("app.admin") }}</RouterLink>
        <a href="#" @click.prevent="logout">{{ t("app.logout") }}</a>
      </template>
      <RouterLink v-else to="/login">{{ t("app.login") }}</RouterLink>
    </div>
  </nav>
  <div v-if="session.site?.announcement?.trim()" class="container">
    <div class="announcement" role="note" :aria-label="t('site.announcement')">
      <SiteMarkdown :text="session.site.announcement" />
    </div>
  </div>
  <main class="container"><RouterView /></main>
  <footer v-if="session.site?.footer?.trim()" class="container site-footer">
    <SiteMarkdown :text="session.site.footer" />
  </footer>
</template>
