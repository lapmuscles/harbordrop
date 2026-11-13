<script setup lang="ts">
defineProps<{ src: string }>();
</script>
<template><iframe :src="src" title="PDF" /></template>
