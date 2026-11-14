<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { fetchBuffer } from "./util";

/** EPUB 預覽（epub.js）：一次下載整本後分頁顯示 */
const props = defineProps<{ src: string; info: { size: number } }>();
const el = ref<HTMLDivElement>();
const status = ref("載入中…");
const location_ = ref("");
let book: any = null;
let rendition: any = null;

onMounted(async () => {
  try {
    const [{ default: ePub }, buf] = await Promise.all([import("epubjs"), fetchBuffer(props.src)]);
    book = ePub(buf as any);
    rendition = book.renderTo(el.value!, { width: "100%", height: "70vh", spread: "none", allowScriptedContent: false });
    rendition.on("relocated", (loc: any) => {
      const p = loc?.start?.percentage;
      location_.value = typeof p === "number" && p > 0 ? `${Math.round(p * 100)}%` : "";
    });
    await rendition.display();
    status.value = "";
    book.ready.then(() => book.locations.generate(1600)).catch(() => {});
  } catch (e: any) {
    status.value = `無法預覽：${e?.message ?? e}`;
  }
});
onBeforeUnmount(() => book?.destroy());

const prev = () => rendition?.prev();
const next = () => rendition?.next();
function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowLeft") prev();
  if (e.key === "ArrowRight") next();
}
</script>

<template>
  <div tabindex="0" @keydown="onKey">
    <p v-if="status" class="muted">{{ status }}</p>
    <div ref="el" style="border: 1px solid #d0d7de; border-radius: 6px" />
    <div class="row" style="justify-content: space-between; align-items: center; margin-top: 8px">
      <button class="ghost" @click="prev">‹ 上一頁</button>
      <span class="muted">{{ location_ }}</span>
      <button class="ghost" @click="next">下一頁 ›</button>
    </div>
  </div>
</template>
