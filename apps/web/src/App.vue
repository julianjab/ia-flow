<script setup lang="ts">
import { RouterView } from 'vue-router';
</script>

<template>
  <RouterView />
  <div id="toast-container" class="toast-container"></div>
</template>

<style>
:root {
  font-family: system-ui, -apple-system, Segoe UI, sans-serif;
}
body {
  margin: 0;
}
.toast-container {
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  z-index: 1000;
}
</style>
