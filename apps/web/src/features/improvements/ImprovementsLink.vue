<script setup lang="ts">
import { onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import { useImprovementsStore } from './store';

// Al pie de «Para mí»: las mejoras que esperan una decisión, en UNA fila que lleva a su pantalla
// (v5, como el menú de Mac). Sin pendientes no se dibuja (R10).

const store = useImprovementsStore();
onMounted(() => void store.load());
</script>

<template>
  <RouterLink v-if="store.count" :to="{ name: 'improvements' }" class="il" data-test="improvements-link">
    <span class="il__icon" aria-hidden="true">✦</span>
    <span class="il__text">{{ store.count }} {{ store.count === 1 ? 'mejora propuesta' : 'mejoras propuestas' }} por la retro</span>
    <span class="il__go">Revisar ›</span>
  </RouterLink>
</template>

<style scoped>
.il { display: flex; align-items: center; gap: 0.6rem; min-height: calc(var(--tap-h) + 0.25rem); padding: 0 0.9rem; border: 1px dashed var(--border-hi); border-radius: var(--radius-lg); color: var(--fg-mute); }
.il:hover { background: var(--panel); color: var(--fg); text-decoration: none; }
.il__icon { color: var(--warn); }
.il__text { flex: 1; min-width: 0; }
.il__go { flex: none; color: var(--fg-dim); font-size: var(--fs-body-sm); }
</style>
