<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import QRCode from "qrcode";
import { api } from "../../api";
import { t } from "../../i18n";
import { copyText, errMsg } from "./adminui";

const status = ref<{ enabled: boolean; pending: boolean } | null>(null);

// --- 修改密碼 ---
const pw = reactive({ oldPassword: "", newPassword: "", confirm: "", totpCode: "" });
const pwMsg = ref("");
const pwErr = ref("");

// --- TOTP ---
const setupPassword = ref("");
const setup = ref<null | { secret: string; otpauthUrl: string; qr: string }>(null);
const enableCode = ref("");
const disableForm = reactive({ password: "", code: "" });
const totpMsg = ref("");
const totpErr = ref("");
const copied = ref("");

async function loadStatus() {
  try {
    status.value = await api.json("GET", "/api/auth/totp");
  } catch (e) {
    totpErr.value = errMsg(e);
  }
}
onMounted(loadStatus);

async function changePassword() {
  pwMsg.value = pwErr.value = "";
  if (pw.newPassword !== pw.confirm) {
    pwErr.value = t("adminui.account.mismatch");
    return;
  }
  try {
    await api.json("POST", "/api/auth/password", {
      oldPassword: pw.oldPassword,
      newPassword: pw.newPassword,
      ...(status.value?.enabled ? { totpCode: pw.totpCode } : {}),
    });
    Object.assign(pw, { oldPassword: "", newPassword: "", confirm: "", totpCode: "" });
    pwMsg.value = t("adminui.account.passwordChanged");
  } catch (e) {
    pwErr.value = errMsg(e);
  }
}

async function startSetup() {
  totpMsg.value = totpErr.value = "";
  try {
    const r = await api.json<{ secret: string; otpauthUrl: string }>("POST", "/api/auth/totp/setup", { password: setupPassword.value });
    // QR 碼在瀏覽器本地產生，秘密不會送往第三方服務
    const qr = await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 220 });
    setup.value = { ...r, qr };
    setupPassword.value = "";
    enableCode.value = "";
    await loadStatus();
  } catch (e) {
    totpErr.value = errMsg(e);
  }
}
async function enable() {
  totpMsg.value = totpErr.value = "";
  try {
    await api.json("POST", "/api/auth/totp/enable", { code: enableCode.value.trim() });
    setup.value = null;
    totpMsg.value = t("adminui.account.enabledOk");
    await loadStatus();
  } catch (e) {
    totpErr.value = errMsg(e);
  }
}
async function cancelSetup() {
  totpErr.value = "";
  try {
    // 未啟用時呼叫 disable 只會清除待啟用的金鑰
    await api.json("POST", "/api/auth/totp/disable", {});
  } catch {
    /* 忽略 */
  }
  setup.value = null;
  await loadStatus();
}
async function disable() {
  totpMsg.value = totpErr.value = "";
  try {
    await api.json("POST", "/api/auth/totp/disable", { password: disableForm.password, code: disableForm.code.trim() });
    Object.assign(disableForm, { password: "", code: "" });
    totpMsg.value = t("adminui.account.disabledOk");
    await loadStatus();
  } catch (e) {
    totpErr.value = errMsg(e);
  }
}
async function copySecret() {
  if (setup.value) copied.value = (await copyText(setup.value.secret)) ? t("adminui.common.copied") : t("adminui.common.copyFailed");
}
</script>

<template>
  <form class="card" @submit.prevent="changePassword">
    <h3>{{ t("adminui.account.changePassword") }}</h3>
    <label>{{ t("adminui.account.oldPassword") }}</label>
    <input v-model="pw.oldPassword" type="password" autocomplete="current-password" required />
    <label>{{ t("adminui.account.newPassword") }}</label>
    <input v-model="pw.newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="256" required />
    <label>{{ t("adminui.account.confirmPassword") }}</label>
    <input v-model="pw.confirm" type="password" autocomplete="new-password" required />
    <template v-if="status?.enabled">
      <label>{{ t("adminui.account.totpCode") }}</label>
      <input v-model="pw.totpCode" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required />
    </template>
    <p v-if="pwErr" class="error">{{ pwErr }}</p>
    <p v-if="pwMsg" class="muted">{{ pwMsg }}</p>
    <button style="margin-top: 10px">{{ t("adminui.common.save") }}</button>
  </form>

  <div class="card">
    <h3>{{ t("adminui.account.totp") }}</h3>
    <p v-if="!status" class="muted">{{ t("adminui.common.loading") }}</p>
    <template v-else>
      <p>
        <strong v-if="status.enabled">✅ {{ t("adminui.account.totpOn") }}</strong>
        <span v-else-if="status.pending && !setup">{{ t("adminui.account.totpPending") }}</span>
        <span v-else>{{ t("adminui.account.totpOff") }}</span>
      </p>

      <!-- 未啟用：產生金鑰 -->
      <form v-if="!status.enabled && !setup" @submit.prevent="startSetup">
        <label>{{ t("adminui.account.setupPassword") }}</label>
        <input v-model="setupPassword" type="password" autocomplete="current-password" required />
        <button style="margin-top: 10px">{{ t("adminui.account.setupStart") }}</button>
      </form>

      <!-- 設定中：顯示 QR 與確認驗證碼 -->
      <form v-if="setup" @submit.prevent="enable">
        <p>{{ t("adminui.account.scan") }}</p>
        <img :src="setup.qr" alt="otpauth QR" width="220" height="220" style="background: #fff; padding: 4px" />
        <label>{{ t("adminui.account.secret") }}</label>
        <div class="row">
          <input class="grow" :value="setup.secret" readonly style="font-family: monospace" />
          <button type="button" class="ghost" @click="copySecret">{{ t("adminui.common.copy") }}</button>
        </div>
        <p v-if="copied" class="muted">{{ copied }}</p>
        <label>{{ t("adminui.account.enterCode") }}</label>
        <input v-model="enableCode" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required />
        <div class="row" style="margin-top: 10px">
          <button>{{ t("adminui.account.enable") }}</button>
          <button type="button" class="ghost" @click="cancelSetup">{{ t("adminui.account.cancelSetup") }}</button>
        </div>
      </form>

      <!-- 已啟用：停用 -->
      <form v-if="status.enabled" @submit.prevent="disable">
        <h4>{{ t("adminui.account.disableTitle") }}</h4>
        <label>{{ t("adminui.account.oldPassword") }}</label>
        <input v-model="disableForm.password" type="password" autocomplete="current-password" required />
        <label>{{ t("adminui.account.totpCode") }}</label>
        <input v-model="disableForm.code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required />
        <button class="danger" style="margin-top: 10px">{{ t("adminui.account.disable") }}</button>
      </form>
    </template>
    <p v-if="totpErr" class="error">{{ totpErr }}</p>
    <p v-if="totpMsg" class="muted">{{ totpMsg }}</p>
  </div>
</template>
