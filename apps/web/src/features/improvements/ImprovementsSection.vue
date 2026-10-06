<script setup lang="ts">
import { onMounted } from 'vue';
import ImprovementCard from './ImprovementCard.vue';
import { useImprovementsStore } from './store';

// «Mejoras propuestas»: lo que dejó el agente de la retrospectiva al mergearse un PR. Una persona
// decide cada una: abrirla como issue o descartarla. Sin pendientes (ni una recién abierta con su
// link) no se dibuja: un contador en cero no se muestra (R10). Arranca abierta porque hay una
// decisión esperando.

defineEmits<{ (e: 'open', ref: string): void }>();

const store = useImprovementsStore();

onMounted(() => void store.load());
</script>

<template>
  <details v-if="store.items.length" class="imp" open data-test="improvements">
    <summary class="imp__head">
      <span class="imp__chev" aria-hidden="true">▸</span>
      <span class="uc-label">Mejoras propuestas</span>
      <span v-if="store.count" class="imp__n mono" data-test="count">{{ store.count }}</span>
      <span class="imp__dim">propuestas por un agente: vos decidís si se abren</span>
    </summary>
    <div class="imp__body">
      <ImprovementCard
        v-for="p in store.items"
        :key="p.id"
        :proposal="p"
        :state="store.states[p.id]"
        @run="store.open(p)"
        @dismiss="store.dismiss(p)"
        @open="$emit('open', $event)"
      />
    </div>
  </details>
</template>

<style scoped>
.imp { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.imp__head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.6rem; min-height: var(--tap-h); padding: 0 0.75rem; cursor: pointer; list-style: none; }
.imp__head::-webkit-details-marker { display: none; }
.imp__head:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.imp__chev { flex: none; color: var(--fg-dim); font-size: var(--fs-micro); transition: transform 120ms ease; }
.imp[open] > .imp__head .imp__chev { transform: rotate(90deg); }
.imp__n { color: var(--accent); font-size: var(--fs-chrome); }
.imp__dim { color: var(--fg-dim); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.imp__body { display: flex; flex-direction: column; gap: 0.5rem; padding: 0 0.75rem 0.75rem; }
</style>
