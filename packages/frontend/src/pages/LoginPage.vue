<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { HdApiError } from "@harbordrop/shared/upload";
import { api, refreshSession } from "../api";
import { t } from "../i18n";
const username = ref("");
const password = ref("");
const error = ref("");
const locked = ref(false);
const busy = ref(false);
// --- feat/admin-ui：TOTP 第二步 ---
const challenge = ref<string | null>(null);
const code = ref("");
const route = useRoute();
const router = useRouter();

type LoginResp = { token: string; expiresAt: number; username: string } | { totpRequired: true; challenge: string; expiresAt: number };

function showError(e: unknown) {
  locked.value = e instanceof HdApiError && e.status === 429;
  error.value = (e as any)?.message || t("login.failed");
  // 挑戰逾時或鎖定：回到第一步重新輸入帳密
  if (e instanceof HdApiError && (e.code === "challenge_expired" || e.status === 429)) {
    challenge.value = null;
    code.value = "";
  }
}
async function done() {
  await refreshSession();
  router.push(String(route.query.next ?? "/admin"));
}
async function submit() {
  error.value = "";
  locked.value = false;
  busy.value = true;
  try {
    const r = await api.json<LoginResp>("POST", "/api/auth/login", { username: username.value, password: password.value });
    if ("totpRequired" in r && r.totpRequired) {
      challenge.value = r.challenge;
      code.value = "";
      return;
    }
    await done();
  } catch (e) {
    showError(e);
  } finally {
    busy.value = false;
  }
}
async function submitTotp() {
  error.value = "";
  locked.value = false;
  busy.value = true;
  try {
    await api.json("POST", "/api/auth/login/totp", { challenge: challenge.value, code: code.value.trim() });
    password.value = "";
    await done();
  } catch (e) {
    showError(e);
  } finally {
    busy.value = false;
  }
}
function back() {
  challenge.value = null;
  code.value = "";
  error.value = "";
}
</script>

<template>
  <form v-if="!challenge" class="card" style="max-width: 360px; margin: 40px auto" @submit.prevent="submit">
    <h2>{{ t("app.login") }}</h2>
    <label>{{ t("login.username") }}</label>
    <input v-model="username" autocomplete="username" required />
    <label>{{ t("login.password") }}</label>
    <input v-model="password" type="password" autocomplete="current-password" required />
    <p v-if="locked" class="error"><strong>{{ t("adminui.login.locked") }}</strong></p>
    <p v-if="error" class="error">{{ error }}</p>
    <button style="margin-top: 16px; width: 100%" :disabled="busy">{{ t("login.submit") }}</button>
  </form>
  <form v-else class="card" style="max-width: 360px; margin: 40px auto" @submit.prevent="submitTotp">
    <h2>{{ t("adminui.login.totpTitle") }}</h2>
    <p class="muted">{{ t("adminui.login.totpHelp") }}</p>
    <label>{{ t("adminui.login.code") }}</label>
    <input v-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required autofocus />
    <p v-if="error" class="error">{{ error }}</p>
    <button style="margin-top: 16px; width: 100%" :disabled="busy">{{ t("adminui.login.verify") }}</button>
    <button type="button" class="ghost" style="margin-top: 8px; width: 100%" @click="back">{{ t("adminui.login.back") }}</button>
  </form>
</template>
