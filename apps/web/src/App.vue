<script setup lang="ts">
import { RouterView } from 'vue-router';
</script>

<template>
  <div class="app-shell">
    <main class="app-main">
      <RouterView />
    </main>
    <div id="toast-container" class="toast-container"></div>
  </div>
</template>

<style>
:root {
  font-family: system-ui, -apple-system, Segoe UI, sans-serif;
}
body {
  margin: 0;
}
.app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.app-main {
  flex: 1;
  padding: 1.5rem;
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
