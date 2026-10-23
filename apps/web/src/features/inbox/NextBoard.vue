<script setup lang="ts">
import { computed } from 'vue';
import BoardHeader from '@/features/inbox/BoardHeader.vue';
import BoardRest from '@/features/inbox/BoardRest.vue';
import ActionError from '@/features/inbox/decisions/ActionError.vue';
import SectionSkeleton from '@/features/inbox/loading/SectionSkeleton.vue';
import EpicsPanel from '@/features/inbox/pipeline/EpicsPanel.vue';
import FeedList from '@/features/inbox/pipeline/FeedList.vue';
import HygieneNote from '@/features/inbox/pipeline/HygieneNote.vue';
import RepoIssuesList from '@/features/inbox/pipeline/RepoIssuesList.vue';
import { loadFailure } from '@/features/inbox/queue/advice';
import { useInboxStore } from '@/features/inbox/store';

// «Próximo»: lo que viene. Las épicas con su avance, TODAS las cards de Todo (las que pueden
// arrancar y las que esperan a otra), el resto del board por columna y los issues de los repos del
// runner que todavía no tienen card. Nada de lo que el runner maneja queda fuera de la vista.

const store = useInboxStore();
const s = computed(() => store.sections);
const queue = computed(() => store.queue);
const feedError = computed(() =>
  store.runnerError ? loadFailure('leer qué le das al pipeline', store.runnerError) : null,
);
const sub = computed(() => {
  const epics = queue.value.epics.length;
  const todo = queue.value.feed?.entries.length ?? 0;
  if (s.value.feed !== 'ready') return '';
  return `${epics} ${epics === 1 ? 'épica' : 'épicas'} · ${todo} en Todo`;
});
</script>

<template>
  <div class="vb">
    <BoardHeader title="Próximo" :sub="sub" />

    <SectionSkeleton v-if="s.epics === 'loading'" shape="epics" />
    <EpicsPanel v-else-if="s.epics === 'ready' && queue.epics.length" :epics="queue.epics" />

    <SectionSkeleton v-if="s.feed === 'loading'" shape="feed" :rows="3" label="cargando Todo…" />
    <ActionError v-else-if="s.feed === 'error' && feedError" :failure="feedError" :busy="store.loading" @retry="store.refresh()" />
    <FeedList
      v-else-if="s.feed === 'ready' && queue.feed"
      id="pipeline-feed"
      :feed="queue.feed"
      :projects="store.projects"
      :project="store.project"
    />

    <div class="vb__list"><BoardRest /></div>
    <RepoIssuesList :projects="store.projects" />
    <HygieneNote v-if="s.decisions === 'ready'" :lines="queue.hygiene" />
  </div>
</template>

<style scoped src="@/features/inbox/board.css" />
<style scoped>
.vb__list { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--panel); overflow: hidden; }
</style>
