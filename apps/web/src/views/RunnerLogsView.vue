<script setup lang="ts">
import { RouterLink } from 'vue-router';
import RunnerLogs from '@/features/runner-health/RunnerLogs.vue';
</script>

<template>
  <div class="view">
    <nav class="view__crumbs" aria-label="Ruta">
      <RouterLink :to="{ name: 'health' }" class="link view__back">‹ Estado del runner</RouterLink>
    </nav>
    <h1 class="view__title">Logs del server</h1>
    <RunnerLogs />
  </div>
</template>

<style scoped>
.view { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; }
.view__crumbs { display: flex; }
.view__back { display: inline-flex; align-items: center; min-height: var(--tap-h); }
.view__title { margin: 0; font-size: var(--fs-display); }
</style>
