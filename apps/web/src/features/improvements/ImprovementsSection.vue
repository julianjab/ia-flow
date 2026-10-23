<script setup lang="ts">
import { onMounted } from 'vue';
import ImprovementRow from './ImprovementRow.vue';
import { useImprovementsStore } from './store';

// «Mejoras propuestas»: lo que dejó el agente de la retrospectiva al mergearse un PR. Una fila corta
// por mejora (v5); tocarla lleva a su pantalla —el porqué, el issue, la columna y las acciones—, con
// su ruta de vuelta, como el detalle de una tarea. Sin pendientes (ni una recién abierta con su
// link) no se dibuja: un contador en cero no se muestra (R10).

const store = useImprovementsStore();

onMounted(() => void store.load());
</script>

<template>
  <section v-if="store.items.length" class="imp" aria-labelledby="imp-h" data-test="improvements">
    <header class="imp__head">
      <h2 id="imp-h" class="imp__title">Mejoras propuestas</h2>
      <span v-if="store.count" class="imp__n" data-test="count">{{ store.count }}</span>
      <span class="imp__dim">las propuso un agente: vos decidís si se abren</span>
    </header>
    <nav class="imp__list" aria-label="Mejoras propuestas">
      <ImprovementRow v-for="p in store.items" :key="p.id" :proposal="p" :state="store.states[p.id]" />
    </nav>
  </section>
</template>

<style scoped>
.imp { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
.imp__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.6rem; }
.imp__title { margin: 0; color: var(--fg-dim); font-family: var(--font-body); font-size: var(--fs-chrome); font-weight: 600; }
.imp__n { color: var(--fg); font-size: var(--fs-chrome); font-weight: 600; }
.imp__dim { color: var(--fg-dim); font-size: var(--fs-chrome); }
.imp__list { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--panel-alt); overflow: hidden; }
</style>
