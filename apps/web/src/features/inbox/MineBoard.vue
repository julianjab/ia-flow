<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import BoardHeader from '@/features/inbox/BoardHeader.vue';
import ActionError from '@/features/inbox/decisions/ActionError.vue';
import DecisionQueue from '@/features/inbox/decisions/DecisionQueue.vue';
import FirstDecision from '@/features/inbox/decisions/FirstDecision.vue';
import SnoozedGroup from '@/features/inbox/decisions/SnoozedGroup.vue';
import SortControl from '@/features/inbox/decisions/SortControl.vue';
import InboxSearch from '@/features/inbox/InboxSearch.vue';
import SectionSkeleton from '@/features/inbox/loading/SectionSkeleton.vue';
import { loadFailure } from '@/features/inbox/queue/advice';
import RulesLegend from '@/features/inbox/RulesLegend.vue';
import SearchResults from '@/features/inbox/SearchResults.vue';
import { useInboxStore } from '@/features/inbox/store';
import { useTaskFocusStore } from '@/stores/taskFocus';

// «Para mí»: lo que espera algo tuyo. La primera decisión en grande y el resto en filas cortas
// (deslizarlas: la acción y Posponer, o Fijar arriba; tocarlas: el detalle con todas), en el orden
// que elijas; las pospuestas, plegadas al final. Con algo escrito en el buscador, los resultados
// reemplazan a la cola. El stream y la carga los maneja el shell: esta vista sólo dibuja.

const store = useInboxStore();
const s = computed(() => store.sections);
const queue = computed(() => store.queue);
const loadError = computed(() => (store.error ? loadFailure('cargar la bandeja', store.error) : null));
const sub = computed(() => {
  const { tasks } = queue.value.headline;
  const snoozed = store.snoozed.length;
  const parts = [`${tasks} ${tasks === 1 ? 'tarea' : 'tareas'}`];
  if (snoozed) parts.push(`${snoozed} ${snoozed === 1 ? 'pospuesta' : 'pospuestas'}`);
  return s.value.decisions === 'ready' ? parts.join(' · ') : '';
});

// Una tarea pedida desde afuera (una card del asistente): se abre y se trae a la vista. Si no es
// una fila de la cola (corre, espera o ya no está), se abre en grande.
const focusRequest = useTaskFocusStore();
watch(
  () => focusRequest.request,
  async () => {
    const ref = focusRequest.consume();
    if (!ref) return;
    store.focus(ref);
    await nextTick();
    const el = document.getElementById(`card-${ref}`);
    if (el) el.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    else store.expand(ref);
  },
  { immediate: true },
);
</script>

<template>
  <div class="vb">
    <BoardHeader title="Para mí" :sub="sub">
      <InboxSearch />
      <SortControl v-if="!store.search" />
    </BoardHeader>

    <ActionError v-if="loadError" :failure="loadError" :busy="store.loading" @retry="store.refresh()" />

    <SearchResults v-if="store.search" />
    <template v-else>
      <SectionSkeleton v-if="s.decisions === 'loading'" shape="queue" label="cargando las decisiones…" />
      <template v-else-if="s.decisions === 'ready'">
        <FirstDecision v-if="queue.first" :entry="queue.first" :total="queue.headline.decisions" />
        <section v-else-if="!store.error" class="vb__empty" data-test="empty">
          <span class="vb__ok" aria-hidden="true">✓</span>
          <h2 class="vb__empty-title">Nada te espera</h2>
          <p class="vb__empty-text">
            {{ queue.pipeline.running }} {{ queue.pipeline.running === 1 ? 'corre' : 'corren' }} y
            {{ queue.pipeline.waiting }} en cola. Te avisa el badge cuando algo te necesite.
          </p>
          <RouterLink class="btn" :to="{ name: 'running' }">Ver En curso</RouterLink>
        </section>
        <DecisionQueue
          v-if="queue.restTotal > 0"
          :rows="queue.rest"
          :total="queue.restTotal"
          :filters="queue.filters"
          @filter="store.setQueueFilter($event)"
        />
      </template>
      <SnoozedGroup />
      <RulesLegend />
    </template>
  </div>
</template>

<style scoped src="@/features/inbox/board.css" />
<style scoped>
.vb__empty { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; padding: 1.5rem 1rem; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--panel); text-align: center; }
.vb__ok { display: grid; place-items: center; width: var(--tap-h); height: var(--tap-h); border-radius: 50%; background: var(--green-bg); color: var(--accent); font-size: var(--fs-num); }
.vb__empty-title { margin: 0; font-size: var(--fs-body); }
.vb__empty-text { margin: 0; color: var(--fg-mute); }
</style>
