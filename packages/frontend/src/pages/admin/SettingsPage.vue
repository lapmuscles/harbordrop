<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, refreshSession } from "../../api";
import { t } from "../../i18n";

interface Def {
  key: string;
  label: string;
  default: unknown;
  input?: "textarea";
  options?: { value: string; label: string }[];
}
const defs = ref<Def[]>([]);
const values = ref<Record<string, any>>({});
const msg = ref("");
const err = ref("");

/** 分組顯示；未列出的設定放到「其他」 */
const GROUPS: { id: string; keys: string[] }[] = [
  { id: "site", keys: ["siteTitle", "siteAnnouncement", "defaultLanguage", "siteFooter"] },
  { id: "anon", keys: ["allowAnonymousUpload", "anonymousMaxBytes", "anonUploadPerHour", "allowAnonymousPaste", "pasteMaxBytes", "anonPastePerHour", "anonymousMaxExpiryHours"] },
  { id: "files", keys: ["fsPublicBrowse"] },
];
const grouped = computed(() => {
  const used = new Set<string>();
  const out = GROUPS.map((g) => {
    const items = g.keys.map((k) => defs.value.find((d) => d.key === k)).filter((d): d is Def => !!d);
    items.forEach((d) => used.add(d.key));
    return { id: g.id, items };
  });
  out.push({ id: "other", items: defs.value.filter((d) => !used.has(d.key)) });
  return out.filter((g) => g.items.length);
});

onMounted(async () => {
  const r = await api.json<any>("GET", "/api/admin/settings");
  defs.value = r.definitions;
  values.value = r.values;
});
async function save() {
  msg.value = "";
  err.value = "";
  try {
    await api.json("PUT", "/api/admin/settings", values.value);
    await refreshSession();
    msg.value = t("site.saved");
  } catch (e: any) {
    err.value = e?.message ?? String(e);
  }
}
</script>
<template>
  <form class="card" @submit.prevent="save">
    <h3>{{ t("admin.settings") }}</h3>
    <fieldset v-for="g in grouped" :key="g.id" style="border: 1px solid var(--line); border-radius: 10px; margin: 0 0 12px; padding: 4px 14px 12px">
      <legend style="padding: 0 6px; font-weight: 600">{{ t(`site.groups.${g.id}`) }}</legend>
      <template v-for="d in g.items" :key="d.key">
        <label :for="`set-${d.key}`">{{ d.label }}</label>
        <input v-if="typeof d.default === 'boolean'" :id="`set-${d.key}`" v-model="values[d.key]" type="checkbox" />
        <select v-else-if="d.options" :id="`set-${d.key}`" v-model="values[d.key]">
          <option v-for="o in d.options" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <textarea v-else-if="d.input === 'textarea'" :id="`set-${d.key}`" v-model="values[d.key]" rows="4" style="width: 100%; font-family: inherit" />
        <input v-else-if="typeof d.default === 'number'" :id="`set-${d.key}`" v-model.number="values[d.key]" type="number" min="0" />
        <input v-else :id="`set-${d.key}`" v-model="values[d.key]" />
      </template>
    </fieldset>
    <p v-if="msg" class="muted">{{ msg }}</p>
    <p v-if="err" class="muted" style="color: var(--err)">{{ err }}</p>
    <button style="margin-top: 12px">{{ t("admin.save") }}</button>
  </form>
</template>
