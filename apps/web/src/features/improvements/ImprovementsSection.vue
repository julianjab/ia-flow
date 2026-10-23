<script setup lang="ts">
import { onMounted } from 'vue';
import type { ImprovementProposal } from '@ia-flow/shared';
import { useAssistantStore } from '@/stores/assistant';
import ImprovementCard from './ImprovementCard.vue';
import { useImprovementsStore } from './store';
import { WHY_QUESTIONS, whyContext, whyScope } from './why';

// «Mejoras propuestas»: lo que dejó el agente de la retrospectiva al mergearse un PR. Una persona
// decide cada una: abrirla como issue o descartarla. Sin pendientes (ni una recién abierta con su
// link) no se dibuja: un contador en cero no se muestra (R10). Arranca abierta porque hay una
// decisión esperando.

defineEmits<{ (e: 'open', ref: string): void }>();

const store = useImprovementsStore();
const assistant = useAssistantStore();

/** «¿Por qué?»: el asistente sobre la tarea que la originó, con la mejora como contexto oculto y la
 *  primera pregunta ya hecha (se sigue preguntando en el chat). */
function ask(p: ImprovementProposal) {
  assistant.open(whyScope(p), WHY_QUESTIONS[0], { title: `la mejora «${p.title}»`, context: whyContext(p) });
}

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
        @run="store.open(p, $event)"
        @dismiss="store.dismiss(p)"
        @ask="ask(p)"
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
