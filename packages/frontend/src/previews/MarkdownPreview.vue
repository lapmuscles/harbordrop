<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { renderMarkdown } from "./markdown";
import { fetchText } from "./util";

/** Markdown 預覽：傳 text 直接渲染（paste 用），否則讀取 src */
const props = defineProps<{ src?: string; info?: { size: number }; text?: string }>();
const html = ref("");
const status = ref("載入中…");

async function load() {
  try {
    if (props.text != null) {
      html.value = renderMarkdown(props.text);
      status.value = "";
      return;
    }
    if (!props.src) return;
    const [text, cut] = await fetchText(props.src, props.info?.size);
    html.value = renderMarkdown(text);
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
    <div class="markdown-body" v-html="html" />
    <p v-if="status" class="muted">{{ status }}</p>
  </div>
</template>

<style>
@import "highlight.js/styles/github.css";
.markdown-body { line-height: 1.7; word-wrap: break-word; }
.markdown-body img { max-width: 100%; }
.markdown-body pre { overflow: auto; padding: 12px; border-radius: 6px; background: #f6f8fa; }
.markdown-body code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
.markdown-body table { border-collapse: collapse; }
.markdown-body th, .markdown-body td { border: 1px solid #d0d7de; padding: 4px 10px; }
.markdown-body blockquote { margin: 0; padding: 0 1em; color: #57606a; border-left: 4px solid #d0d7de; }
</style>
