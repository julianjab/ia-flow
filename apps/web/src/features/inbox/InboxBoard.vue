<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import { useIsMobile, useIsSplit } from '@/composables/useIsMobile';
import BoardRest from '@/features/inbox/BoardRest.vue';
import ActionError from '@/features/inbox/decisions/ActionError.vue';
import DecisionQueue from '@/features/inbox/decisions/DecisionQueue.vue';
import FirstDecision from '@/features/inbox/decisions/FirstDecision.vue';
import InboxHeadline from '@/features/inbox/decisions/InboxHeadline.vue';
import InboxToolbar from '@/features/inbox/InboxToolbar.vue';
import SectionSkeleton from '@/features/inbox/loading/SectionSkeleton.vue';
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
//
// Cada sección pinta en cuanto llega SU dato (`store.sections`): mientras tanto, su esqueleto con
// la misma forma. Lo que llega aparece con un fade corto, escalonado en el orden real de llegada;
// sólo en la primera carga: un refresco mantiene lo pintado, sin esqueleto ni animación.

const store = useInboxStore();
const { isSplit } = useIsSplit();
const { isMobile } = useIsMobile();
const s = computed(() => store.sections);

/** Se anima sólo lo que llega con la pantalla abierta: al volver a ella con todo cargado, no. */
const animate = Object.values(store.sections).some((state) => state === 'loading');
const rv = (i: number) => (animate ? ['reveal', `reveal-${i}`] : []);

onMounted(() => store.start());
onBeforeUnmount(() => store.stop());

const queue = computed(() => store.queue);
const loadError = computed(() => (store.error ? loadFailure('cargar la bandeja', store.error) : null));
const feedError = computed(() =>
  store.runnerError ? loadFailure('leer qué le das al pipeline', store.runnerError) : null,
);

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

    <div class="board__cols">
      <div class="board__main">
        <SectionSkeleton v-if="s.decisions === 'loading'" shape="headline" />
        <template v-else-if="s.decisions === 'ready'">
          <InboxHeadline v-if="queue.first" :class="rv(0)" :headline="queue.headline" />
          <p v-else-if="!store.error" class="board__note board__note--ok" :class="rv(0)">
            ✓ Todo en orden: nada te necesita y nada falló.
          </p>
        </template>

        <template v-if="!isSplit">
          <SectionSkeleton v-if="s.pipeline === 'loading'" shape="pipeline-line" label="cargando el pipeline…" />
          <PipelineLine v-else-if="s.pipeline === 'ready'" :class="rv(1)" :pipeline="queue.pipeline" :running="queue.running" :blocked="queue.blocked" />
        </template>

        <SectionSkeleton v-if="s.decisions === 'loading'" shape="queue" label="cargando las decisiones…" />
        <template v-else-if="s.decisions === 'ready'">
          <FirstDecision v-if="queue.first" :class="rv(1)" :entry="queue.first" :total="queue.headline.decisions" />
          <DecisionQueue
            v-if="queue.restTotal > 0"
            :class="rv(2)"
            :rows="queue.rest"
            :total="queue.restTotal"
            :filters="queue.filters"
            @filter="store.setQueueFilter($event)"
          />
        </template>

        <SectionSkeleton v-if="s.feed === 'loading'" shape="feed" :rows="isMobile ? 0 : 3" label="cargando qué le das al pipeline…" />
        <ActionError v-else-if="s.feed === 'error' && feedError" :failure="feedError" :busy="store.loading" @retry="store.refresh()" />
        <FeedList v-else-if="s.feed === 'ready' && queue.feed" id="pipeline-feed" :class="rv(0)" :feed="queue.feed" />

        <template v-if="!isSplit && s.decisions === 'ready'">
          <div v-if="queue.epics.length" :class="rv(3)"><EpicsPanel :epics="queue.epics" folded /></div>
          <HygieneNote :lines="queue.hygiene" />
        </template>

        <BoardRest />
        <RulesLegend />
      </div>

      <aside v-if="isSplit" class="board__aside" aria-label="El pipeline, las épicas y el board">
        <SectionSkeleton v-if="s.pipeline === 'loading'" shape="pipeline" label="cargando el pipeline…" />
        <PipelineCells
          v-else-if="s.pipeline === 'ready'"
          :class="rv(0)"
          :pipeline="queue.pipeline"
          :running="queue.running"
          :queued="queue.queued"
          :blocked="queue.blocked"
          :feed="queue.feed"
          feed-anchor="pipeline-feed"
        />
        <SectionSkeleton v-if="s.epics === 'loading'" shape="epics" />
        <template v-else-if="s.epics === 'ready'">
          <div v-if="queue.epics.length" :class="rv(1)"><EpicsPanel :epics="queue.epics" /></div>
          <HygieneNote :lines="queue.hygiene" />
        </template>
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
.reveal-1 { --reveal-i: 1; }
.reveal-2 { --reveal-i: 2; }
.reveal-3 { --reveal-i: 3; }
.board__note--ok { padding: 1rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); color: var(--accent); }
</style>
