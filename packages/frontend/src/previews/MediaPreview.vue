<script setup lang="ts">
defineProps<{ src: string; info: { previewKind: string } }>();
</script>
<template>
  <video v-if="info.previewKind === 'video'" :src="src" controls preload="metadata" />
  <audio v-else :src="src" controls preload="metadata" style="width: 100%" />
</template>
