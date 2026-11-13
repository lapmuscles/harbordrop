<script setup lang="ts">
import { onMounted, ref } from "vue";
const props = defineProps<{ src: string; info: { size: number } }>();
const MAX = 1024 * 1024;
const text = ref("載入中…");
onMounted(async () => {
  // 只讀前 1MB，避免大檔卡住瀏覽器
  const r = await fetch(props.src, { headers: props.info.size > MAX ? { Range: `bytes=0-${MAX - 1}` } : {} });
  const buf = await r.arrayBuffer();
  text.value = new TextDecoder().decode(buf.slice(0, MAX)) + (props.info.size > MAX ? "\n…（僅顯示前 1MB）" : "");
});
</script>
<template><pre>{{ text }}</pre></template>
