<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, refreshSession } from "../api";
import { t } from "../i18n";
const username = ref("");
const password = ref("");
const error = ref("");
const route = useRoute();
const router = useRouter();
async function submit() {
  error.value = "";
  try {
    await api.json("POST", "/api/auth/login", { username: username.value, password: password.value });
    await refreshSession();
    router.push(String(route.query.next ?? "/admin"));
  } catch (e: any) {
    error.value = e.message || t("login.failed");
  }
}
</script>

<template>
  <form class="card" style="max-width: 360px; margin: 40px auto" @submit.prevent="submit">
    <h2>{{ t("app.login") }}</h2>
    <label>{{ t("login.username") }}</label>
    <input v-model="username" autocomplete="username" required />
    <label>{{ t("login.password") }}</label>
    <input v-model="password" type="password" autocomplete="current-password" required />
    <p v-if="error" class="error">{{ error }}</p>
    <button style="margin-top: 16px; width: 100%">{{ t("login.submit") }}</button>
  </form>
</template>
