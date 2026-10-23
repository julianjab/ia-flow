<script setup lang="ts">
import { computed } from 'vue';
import { useInboxStore } from '@/features/inbox/store';
import RunnerHealthPanel from '@/features/runner-health/RunnerHealthPanel.vue';
import { currentBaseUrl } from '@/features/servers/selection';

// «Estado del runner»: salud, capacidad y recursos del runner elegido. La ocupación sale de la
// bandeja, que ya la tiene (el shell la mantiene viva); mientras no llega, la fila no se dibuja.
const inbox = useInboxStore();
const occupancy = computed(() => (inbox.sections.pipeline === 'ready' ? inbox.queue.pipeline : null));
const host = computed(() => {
  try {
    return new URL(currentBaseUrl()).host;
  } catch {
    return currentBaseUrl();
  }
});
</script>

<template>
  <div class="view">
    <h1 class="view__title">Estado del runner</h1>
    <RunnerHealthPanel :host="host" :occupancy="occupancy" />
  </div>
</template>

<style scoped>
.view { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; max-width: 46rem; }
.view__title { margin: 0; font-size: var(--fs-display); }
</style>
