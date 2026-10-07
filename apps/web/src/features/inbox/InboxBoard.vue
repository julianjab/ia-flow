<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import { useIsSplit } from '@/composables/useIsMobile';
import BoardRest from '@/features/inbox/BoardRest.vue';
import ActionError from '@/features/inbox/decisions/ActionError.vue';
import DecisionQueue from '@/features/inbox/decisions/DecisionQueue.vue';
import FirstDecision from '@/features/inbox/decisions/FirstDecision.vue';
import InboxHeadline from '@/features/inbox/decisions/InboxHeadline.vue';
import InboxToolbar from '@/features/inbox/InboxToolbar.vue';
import EpicsPanel from '@/features/inbox/pipeline/EpicsPanel.vue';
import FeedList from '@/features/inbox/pipeline/FeedList.vue';
import HygieneNote from '@/features/inbox/pipeline/HygieneNote.vue';
import PipelineCells from '@/features/inbox/pipeline/PipelineCells.vue';
import PipelineLine from '@/features/inbox/pipeline/PipelineLine.vue';
import { loadFailure } from '@/features/inbox/queue/advice';
import RulesLegend from '@/features/inbox/RulesLegend.vue';
import { useInboxStore } from '@/features/inbox/store';
import TaskDetailDrawer from '@/features/inbox/TaskDetailDrawer.vue';
import { useTaskFocusStore } from '@/stores/taskFocus';

// La bandeja como cola de decisiones: el titular, «Lo primero» en grande, «Después» numerado,
// lo que le das al pipeline, y plegados el board de GitHub y cómo se ordena. Lo que corre o
// espera no es una tarjeta: son números, al costado desde 1100 px y en una línea bajo el
// titular por debajo. Se suscribe al stream del runner mientras está montada.

const store = useInboxStore();
const { isSplit } = useIsSplit();

onMounted(() => store.start());
onBeforeUnmount(() => store.stop());

const queue = computed(() => store.queue);
const ready = computed(() => store.inbox !== null);
const loadError = computed(() => (store.error ? loadFailure('cargar la bandeja', store.error) : null));

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
  <div class="board">
    <header class="board__top">
      <h1 class="board__title">Bandeja</h1>
      <InboxToolbar
        :projects="store.projects"
        :project="store.project"
        :stream="store.streamState"
        :loading="store.loading"
        @project="store.project = $event"
        @refresh="store.refresh()"
      />
    </header>

    <ActionError v-if="loadError" :failure="loadError" :busy="store.loading" @retry="store.refresh()" />

    <p v-if="store.loading && !ready" class="board__note">· cargando la bandeja…</p>

    <div v-else-if="ready" class="board__cols">
      <div class="board__main">
        <InboxHeadline v-if="queue.first" :headline="queue.headline" />
        <p v-else-if="!store.error" class="board__note board__note--ok">
          ✓ Todo en orden: nada te necesita y nada falló.
        </p>

        <PipelineLine v-if="!isSplit" :pipeline="queue.pipeline" :running="queue.running" />

        <FirstDecision v-if="queue.first" :entry="queue.first" :total="queue.headline.decisions" />

        <DecisionQueue
          v-if="queue.restTotal > 0"
          :rows="queue.rest"
          :total="queue.restTotal"
          :filters="queue.filters"
          @filter="store.setQueueFilter($event)"
        />

        <FeedList v-if="queue.feed" :feed="queue.feed" />
        <EpicsPanel v-if="!isSplit" :epics="queue.epics" folded />
        <HygieneNote v-if="!isSplit" :lines="queue.hygiene" />

        <BoardRest />
        <RulesLegend />
      </div>

      <aside v-if="isSplit" class="board__aside" aria-label="El pipeline, las épicas y el board">
        <PipelineCells :pipeline="queue.pipeline" :running="queue.running" :queued="queue.queued" />
        <EpicsPanel :epics="queue.epics" />
        <HygieneNote :lines="queue.hygiene" />
      </aside>
    </div>

    <TaskDetailDrawer />
  </div>
</template>

<style scoped>
.board { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
.board__top { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 1rem; }
.board__top > :last-child { flex: 1 1 auto; }
/* El título de la pantalla: versalitas de display, como el mockup. Los bloques de abajo son h2. */
.board__title { margin: 0; font-size: var(--fs-body); text-transform: uppercase; letter-spacing: var(--tracking-hd); }
.board__cols { display: grid; gap: 1.25rem; min-width: 0; }
.board__main { display: flex; flex-direction: column; gap: 0.9rem; min-width: 0; }
.board__aside { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
/* 1100 habilita la segunda columna: la cola flexible y el pipeline al costado. */
@media (min-width: 1100px) {
  .board__cols { grid-template-columns: minmax(0, 1fr) clamp(18rem, 26vw, 22rem); align-items: start; gap: 1.5rem; }
  .board__aside { position: sticky; top: 1rem; }
}
.board__note { margin: 0; color: var(--fg-dim); }
.board__note--ok { padding: 1rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); color: var(--accent); }
</style>
