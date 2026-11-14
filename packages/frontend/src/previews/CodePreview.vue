<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { highlightCode } from "./markdown";
import { CODE_EXT, extOf, fetchText } from "./util";

/** 程式碼預覽（highlight.js）：傳 text＋lang（paste 用）或 src＋info.filename */
const props = defineProps<{ src?: string; info?: { size: number; filename?: string }; text?: string; lang?: string }>();
const code = ref("");
const status = ref("載入中…");
const wrap = ref(false);
const lang = computed(() => props.lang || CODE_EXT[extOf(props.info?.filename)] || undefined);
const html = computed(() => highlightCode(code.value, lang.value));
const lines = computed(() => code.value.split("\n").length);

async function load() {
  try {
    if (props.text != null) {
      code.value = props.text;
      status.value = "";
      return;
    }
    if (!props.src) return;
    const [text, cut] = await fetchText(props.src, props.info?.size);
    code.value = text;
    status.value = cut ? "（僅顯示前 1MB）" : "";
  } catch (e: any) {
    status.value = e.message;
  }
}
onMounted(load);
watch(() => props.text, load);
</script>

<template>
  <div>
    <div class="row muted" style="font-size: 13px; gap: 12px; align-items: center">
      <span>{{ lang ?? "自動偵測" }} · {{ lines }} 行</span>
      <label style="display: flex; gap: 4px; align-items: center"><input v-model="wrap" type="checkbox" style="width: auto" />自動換行</label>
    </div>
    <pre class="hljs code-preview" :style="{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }"><code v-html="html" /></pre>
    <p v-if="status" class="muted">{{ status }}</p>
  </div>
</template>

<style>
@import "highlight.js/styles/github.css";
.code-preview { overflow: auto; padding: 12px; border-radius: 6px; background: #f6f8fa; font-size: 13px; line-height: 1.5; max-height: 75vh; }
</style>
