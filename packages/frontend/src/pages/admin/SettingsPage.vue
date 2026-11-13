<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, refreshSession } from "../../api";
import { t } from "../../i18n";

const defs = ref<{ key: string; label: string; default: unknown }[]>([]);
const values = ref<Record<string, any>>({});
const msg = ref("");
onMounted(async () => {
  const r = await api.json<any>("GET", "/api/admin/settings");
  defs.value = r.definitions;
  values.value = r.values;
});
async function save() {
  await api.json("PUT", "/api/admin/settings", values.value);
  await refreshSession();
  msg.value = "已儲存";
}
</script>
<template>
  <form class="card" @submit.prevent="save">
    <h3>{{ t("admin.settings") }}</h3>
    <template v-for="d in defs" :key="d.key">
      <label>{{ d.label }}</label>
      <input v-if="typeof d.default === 'boolean'" v-model="values[d.key]" type="checkbox" />
      <input v-else-if="typeof d.default === 'number'" v-model.number="values[d.key]" type="number" />
      <input v-else v-model="values[d.key]" />
    </template>
    <p v-if="msg" class="muted">{{ msg }}</p>
    <button style="margin-top: 12px">{{ t("admin.save") }}</button>
  </form>
</template>
