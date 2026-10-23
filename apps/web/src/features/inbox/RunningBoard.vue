<script setup lang="ts">
import { computed } from 'vue';
import BoardHeader from '@/features/inbox/BoardHeader.vue';
import SectionSkeleton from '@/features/inbox/loading/SectionSkeleton.vue';
import PipelineCells from '@/features/inbox/pipeline/PipelineCells.vue';
import { useInboxStore } from '@/features/inbox/store';

// «En curso»: los lugares del runner (corriendo · en cola · libres, cada celda abre su lista), lo
// que espera a otra tarea y lo último que corrió. Es el panel que antes iba al costado de la bandeja.

const store = useInboxStore();
const queue = computed(() => store.queue);
const sub = computed(() => {
  const p = queue.value.pipeline;
  if (store.sections.pipeline !== 'ready') return '';
  const free = p.free !== undefined ? ` · ${p.free} ${p.free === 1 ? 'lugar libre' : 'lugares libres'}` : '';
  return `${p.running} corriendo · ${p.waiting} en cola${free}`;
});
</script>

<template>
  <div class="vb">
    <BoardHeader title="En curso" :sub="sub" />
    <SectionSkeleton v-if="store.sections.pipeline === 'loading'" shape="pipeline" label="cargando el pipeline…" />
    <PipelineCells
      v-else-if="store.sections.pipeline === 'ready'"
      :pipeline="queue.pipeline"
      :running="queue.running"
      :queued="queue.queued"
      :blocked="queue.blocked"
      :recent="queue.recent"
      :feed="queue.feed"
    />
  </div>
</template>

<style scoped src="@/features/inbox/board.css" />
