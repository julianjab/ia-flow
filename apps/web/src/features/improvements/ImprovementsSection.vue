<script setup lang="ts">
import type { ImprovementProposal } from '@ia-flow/shared';
import { computed, onMounted, ref } from 'vue';
import { useAssistantStore } from '@/stores/assistant';
import BottomSheet from '@/ui/BottomSheet.vue';
import ImprovementCard from './ImprovementCard.vue';
import ImprovementRow from './ImprovementRow.vue';
import { useImprovementsStore } from './store';
import { WHY_QUESTIONS, whyContext, whyScope } from './why';

// «Mejoras propuestas»: lo que dejó el agente de la retrospectiva al mergearse un PR. Una fila corta
// por mejora (v5); tocarla abre su detalle en un sheet —el porqué, el issue, la columna y las
// acciones—, donde una persona decide: abrirla como issue, descartarla o preguntar por qué. Sin
// pendientes (ni una recién abierta con su link) no se dibuja: un contador en cero no se muestra (R10).

const emit = defineEmits<{ (e: 'open', ref: string): void }>();

const store = useImprovementsStore();
const assistant = useAssistantStore();

/** La mejora abierta en el detalle. */
const selectedId = ref<string | null>(null);
const selected = computed(() => store.items.find((p) => p.id === selectedId.value) ?? null);

/** «¿Por qué?»: el asistente sobre la tarea que la originó, con la mejora como contexto oculto y la
 *  primera pregunta ya hecha (se sigue preguntando en el chat). */
function ask(p: ImprovementProposal) {
  selectedId.value = null;
  assistant.open(whyScope(p), WHY_QUESTIONS[0], { title: `la mejora «${p.title}»`, context: whyContext(p) });
}

/** Ir a la tarea de origen cierra el detalle: la tarea se abre en la bandeja. */
function openTask(ref: string) {
  selectedId.value = null;
  emit('open', ref);
}

onMounted(() => void store.load());
</script>

<template>
  <section v-if="store.items.length" class="imp" aria-labelledby="imp-h" data-test="improvements">
    <header class="imp__head">
      <h2 id="imp-h" class="imp__title">Mejoras propuestas</h2>
      <span v-if="store.count" class="imp__n" data-test="count">{{ store.count }}</span>
      <span class="imp__dim">las propuso un agente: vos decidís si se abren</span>
    </header>
    <div class="imp__list">
      <ImprovementRow
        v-for="p in store.items"
        :key="p.id"
        :proposal="p"
        :state="store.states[p.id]"
        @select="selectedId = p.id"
      />
    </div>

    <BottomSheet :open="selected !== null" title="Mejora propuesta" @close="selectedId = null">
      <div v-if="selected" class="imp__detail">
        <ImprovementCard
          :proposal="selected"
          :state="store.states[selected.id]"
          @run="store.open(selected, $event)"
          @dismiss="store.dismiss(selected); selectedId = null"
          @ask="ask(selected)"
          @open="openTask"
        />
      </div>
    </BottomSheet>
  </section>
</template>

<style scoped>
.imp { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
.imp__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.6rem; }
.imp__title { margin: 0; color: var(--fg-dim); font-family: var(--font-body); font-size: var(--fs-chrome); font-weight: 600; }
.imp__n { color: var(--fg); font-size: var(--fs-chrome); font-weight: 600; }
.imp__dim { color: var(--fg-dim); font-size: var(--fs-chrome); }
.imp__list { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--panel-alt); overflow: hidden; }
/* Dentro del sheet la card no lleva su caja: el sheet ya es la caja. */
.imp__detail { padding: 0 1rem 1rem; }
.imp__detail :deep(.ic) { padding: 0; border: 0; background: none; }
</style>
