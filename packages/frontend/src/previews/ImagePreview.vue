<script setup lang="ts">
defineProps<{ src: string; info: { filename: string } }>();
</script>
<template><img :src="src" :alt="info.filename" /></template>
