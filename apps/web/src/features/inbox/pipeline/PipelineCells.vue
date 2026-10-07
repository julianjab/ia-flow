<script setup lang="ts">
import { computed, ref } from 'vue';
import PipelineCell from '@/features/inbox/pipeline/PipelineCell.vue';
import RunningList from '@/features/inbox/pipeline/RunningList.vue';
import type { PipelineSummary, RunningEntry } from '@/features/inbox/queue/build';

// «El pipeline», al costado desde 1100 px: tres números (corriendo · en cola · libres de max).
// Una celda con algo adentro se abre —«corriendo» lista lo que corre, «en cola» lo que espera,
// «libres» explica quién toma el lugar—, de a una por vez; una celda vacía es sólo número.

type Cell = 'running' | 'waiting' | 'free';

const props = defineProps<{ pipeline: PipelineSummary; running: RunningEntry[]; queued?: RunningEntry[] }>();
const waiting = computed(() => props.queued ?? []);
const hasFree = computed(() => props.pipeline.free !== undefined);
const can = computed<Record<Cell, boolean>>(() => ({
  running: props.running.length > 0,
  waiting: waiting.value.length > 0,
  free: hasFree.value,
}));
/** La celda abierta: arranca la de lo que corre (se ve sólo si hay algo corriendo). */
const open = ref<Cell | null>('running');
const isOpen = (cell: Cell) => can.value[cell] && open.value === cell;
const toggle = (cell: Cell) => {
  open.value = open.value === cell ? null : cell;
};
const freeLabel = computed(() => {
  const word = props.pipeline.free === 1 ? 'libre' : 'libres';
  return props.pipeline.max === undefined ? word : `${word} de ${props.pipeline.max}`;
});
const note = computed(() =>
  props.pipeline.source === 'capacity'
    ? 'Cuenta ejecuciones, no tarjetas. Si una corrida falla, aparece en tus decisiones.'
    : 'Cuenta tarjetas: este runner no publica su capacidad.',
);
</script>

<template>
  <section class="pc" aria-labelledby="pipe-h">
    <h2 id="pipe-h" class="pc__hd sec-hd"><span class="live-dot" aria-hidden="true" />El pipeline</h2>
    <div class="pc__cells">
      <PipelineCell
        :n="pipeline.running"
        label="corriendo"
        controls="pipe-running"
        :expandable="can.running"
        :open="isOpen('running')"
        data-test="cell-running"
        @toggle="toggle('running')"
      />
      <PipelineCell
        :n="pipeline.waiting"
        label="en cola"
        controls="pipe-waiting"
        :expandable="can.waiting"
        :open="isOpen('waiting')"
        data-test="cell-waiting"
        @toggle="toggle('waiting')"
      />
      <PipelineCell
        v-if="pipeline.free !== undefined"
        :n="pipeline.free"
        :label="freeLabel"
        controls="pipe-free"
        expandable
        free
        :open="isOpen('free')"
        data-test="cell-free"
        @toggle="toggle('free')"
      />
    </div>
    <div v-show="isOpen('running')" id="pipe-running" class="pc__list">
      <RunningList v-if="can.running" :running="running" />
    </div>
    <div v-show="isOpen('waiting')" id="pipe-waiting" class="pc__list">
      <RunningList v-if="can.waiting" :running="waiting" waiting />
    </div>
    <p v-show="isOpen('free')" id="pipe-free" class="pc__list pc__explain">
      Lo toma lo primero que pase a Refine o a Build; aprobar un PRD también lo ocupa.
    </p>
    <p class="pc__note">{{ note }}</p>
  </section>
</template>

<style scoped src="@/features/inbox/section.css" />
<style scoped>
.pc { display: flex; flex-direction: column; gap: 0.6rem; padding: 0.8rem 0.9rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.pc__hd { display: flex; align-items: center; gap: 0.5rem; }
.pc__cells { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.35rem; }
.pc__list { margin: 0; border-top: 1px solid var(--border-mute); }
.pc__explain { padding-top: 0.5rem; color: var(--fg-mute); font-size: var(--fs-chrome); line-height: 1.45; }
.pc__note { margin: 0; color: var(--fg-dim); font-size: var(--fs-micro); line-height: 1.45; }
</style>
