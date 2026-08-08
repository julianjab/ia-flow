<script setup lang="ts">
// Full detail tabs land in later commits. Shell so router compiles.
const props = defineProps<{ id: string; tab: string }>();
</script>

<template>
  <header class="detail-header">
    <h1>Proyecto: {{ props.id }}</h1>
    <p>Tab: {{ props.tab }} (contenido en construcción)</p>
  </header>
</template>

<style scoped>
.detail-header h1 { margin: 0 0 0.25rem; font-size: 1.75rem; }
.detail-header p  { margin: 0 0 1.5rem; color: #6b7280; font-size: 0.9rem; }
</style>
