<script setup lang="ts">
// 站台公告／頁尾：Markdown 轉 HTML 後經 DOMPurify 淨化；markdown 模組按需載入，避免拖慢首頁
import { ref, watch } from "vue";
const props = defineProps<{ text: string }>();
const html = ref("");
watch(
  () => props.text,
  async (v) => {
    if (!v?.trim()) return void (html.value = "");
    const m = await import("../previews/markdown");
    html.value = m.sanitizeHtml(m.renderMarkdown(v));
  },
  { immediate: true },
);
</script>
<template>
  <div v-if="html" class="site-md" v-html="html" />
</template>
