<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from "vue";
import { extOf, fetchBuffer } from "./util";
import { sanitizeHtml } from "./markdown";

/**
 * Office 預覽：
 *   docx → docx-preview；xlsx/xls/ods/csv → SheetJS；
 *   doc/ppt/pptx → Microsoft Office Online Viewer（需公開網址，由使用者確認後才載入）
 */
const props = defineProps<{ src: string; info: { size: number; filename: string } }>();
const ext = computed(() => extOf(props.info.filename));
const mode = computed(() => (ext.value === "docx" ? "docx" : ["xlsx", "xlsm", "xls", "ods", "csv"].includes(ext.value) ? "sheet" : "online"));
const status = ref("");
const docEl = ref<HTMLDivElement>();
const sheets = shallowRef<{ name: string; html: string }[]>([]);
const current = ref(0);
const useOnline = ref(false);
const MAX_SHEET_BYTES = 30 * 1024 * 1024;

const absoluteSrc = computed(() => new URL(props.src, location.href).href);
const onlineUrl = computed(() => `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(absoluteSrc.value)}`);
const isPublicHost = computed(() => !/^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(location.hostname));

onMounted(async () => {
  if (mode.value === "online") return;
  status.value = "載入中…";
  try {
    if (mode.value === "sheet" && props.info.size > MAX_SHEET_BYTES) throw new Error("試算表太大，請直接下載");
    const buf = await fetchBuffer(props.src);
    if (mode.value === "docx") {
      const { renderAsync } = await import("docx-preview");
      await renderAsync(buf, docEl.value!, undefined, { inWrapper: true, ignoreLastRenderedPageBreak: true });
    } else {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(buf, { type: "array", dense: true });
      sheets.value = wb.SheetNames.map((name) => ({ name, html: sanitizeHtml(XLSX.utils.sheet_to_html(wb.Sheets[name], { editable: false })) }));
    }
    status.value = "";
  } catch (e: any) {
    status.value = `無法預覽：${e?.message ?? e}`;
  }
});
</script>

<template>
  <div class="office-preview">
    <p v-if="status" class="muted">{{ status }}</p>
    <div v-if="mode === 'docx'" ref="docEl" class="docx-host" />
    <template v-else-if="mode === 'sheet' && sheets.length">
      <div class="row" style="gap: 6px; flex-wrap: wrap">
        <button v-for="(s, i) in sheets" :key="s.name" :class="i === current ? '' : 'ghost'" @click="current = i">{{ s.name }}</button>
      </div>
      <div class="sheet-host" v-html="sheets[current].html" />
    </template>
    <template v-else-if="mode === 'online'">
      <template v-if="!useOnline">
        <p class="muted">
          此格式（.{{ ext }}）需透過 Microsoft Office Online 檢視器預覽：檔案網址會傳給微軟伺服器讀取，且會計入一次瀏覽。
          <template v-if="!isPublicHost">目前網站不是公開網址，檢視器可能無法讀取。</template>
        </p>
        <button class="ghost" @click="useOnline = true">使用 Office Online 預覽</button>
      </template>
      <iframe v-else :src="onlineUrl" style="width: 100%; height: 75vh; border: 0" referrerpolicy="no-referrer" />
    </template>
  </div>
</template>

<style>
.docx-host { max-height: 80vh; overflow: auto; }
.sheet-host { max-height: 75vh; overflow: auto; margin-top: 8px; }
.sheet-host table { border-collapse: collapse; font-size: 13px; }
.sheet-host td { border: 1px solid #d0d7de; padding: 2px 6px; white-space: nowrap; }
</style>
