<script setup lang="ts">
import { computed, ref } from 'vue';
import BlockedList from '@/features/inbox/pipeline/BlockedList.vue';
import RecentRuns from '@/features/inbox/pipeline/RecentRuns.vue';
import RunningList from '@/features/inbox/pipeline/RunningList.vue';
import type { PipelineSummary, RunningEntry } from '@/features/inbox/queue/build';
import type { RecentRun } from '@/features/inbox/queue/recent';
import type { BlockedEntry } from '@/features/inbox/queue/runnerFeed';
import type { StreamState } from '@/features/inbox/stream';
import BottomSheet from '@/ui/BottomSheet.vue';

// «El pipeline» en un teléfono: una franja arriba de la bandeja con lo que corre, lo que espera y
// cuánto lugar queda —y si la bandeja está en vivo—, más cómo terminó lo último que corrió. Tocarla
// abre un sheet con lo que corre (con su «Detener…»), lo que ya corrió, lo bloqueado y la capacidad
// dibujada. Reemplaza al plegable de `PipelineLine` bajo
// 768px y al «en vivo» de la toolbar: es UNA línea de estado, no dos.

const props = defineProps<{
  pipeline: PipelineSummary;
  running: RunningEntry[];
  blocked?: readonly BlockedEntry[];
  recent?: readonly RecentRun[];
  stream: StreamState;
}>();

const open = ref(false);

const STREAM_COPY: Partial<Record<StreamState, string>> = {
  connecting: 'conectando…',
  reconnecting: 'reconectando…',
  polling: 'cada 30 s',
};
const streamCopy = computed(() => STREAM_COPY[props.stream]);

const GLYPH = { done: '✓', failed: '✕', superseded: '↷' } as const;
/** La última que cerró, en la misma línea: «0 corriendo» no dice que hace 30 min terminó algo. */
const last = computed(() => props.recent?.[0]);

/** Una celda por lugar del pipeline, ocupado o libre. Sin capacidad publicada no hay lugares que dibujar. */
const cells = computed(() => {
  const { running, max } = props.pipeline;
  if (max === undefined) return [];
  const busy = Math.min(running, max);
  return Array.from({ length: max }, (_, i) => (i < busy ? 'run' : 'free'));
});
</script>

<template>
  <button type="button" class="ps" data-test="pipeline-strip" :data-stream="stream" @click="open = true">
    <span v-if="stream === 'live'" class="live-dot" aria-hidden="true" />
    <span v-else class="ps__off" aria-hidden="true" />
    <span class="ps__txt">
      <b>{{ pipeline.running }}</b> corriendo · <b>{{ pipeline.waiting }}</b> en cola<template v-if="pipeline.free !== undefined">
        · {{ pipeline.free }} {{ pipeline.free === 1 ? 'libre' : 'libres' }}<template v-if="pipeline.max !== undefined"> de {{ pipeline.max }}</template></template>
    </span>
    <span v-if="last && last.age.text" class="ps__last" :data-status="last.status" data-test="strip-last" :title="`Lo último: ${last.title}`">
      {{ GLYPH[last.status] }} {{ last.age.text }}
    </span>
    <span v-if="streamCopy" class="ps__stream">{{ streamCopy }}</span>
    <span class="ps__chev" aria-hidden="true">›</span>
  </button>

  <BottomSheet :open="open" title="El pipeline" @close="open = false">
    <div class="ps__sheet">
      <div v-if="cells.length" class="ps__cap" role="img" :aria-label="`${Math.min(pipeline.running, pipeline.max ?? 0)} de ${pipeline.max} lugares ocupados`">
        <i v-for="(c, i) in cells" :key="i" :data-cell="c" />
      </div>
      <RunningList v-if="running.length" :running="running" />
      <p v-else class="ps__empty">Nada corre ahora.</p>
      <RecentRuns :runs="recent ?? []" />
      <BlockedList :blocked="blocked ?? []" />
      <p class="ps__note">
        {{ pipeline.source === 'capacity' ? 'Cuenta ejecuciones, no tarjetas.' : 'Cuenta tarjetas: este runner no publica su capacidad.' }}
      </p>
    </div>
  </BottomSheet>
</template>

<style scoped>
.ps {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  min-height: var(--tap-h);
  padding: 0 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  color: var(--fg-mute);
  font: inherit;
  font-size: var(--fs-body-sm);
  text-align: left;
  cursor: pointer;
}
.ps:hover { border-color: var(--border-hi); }
.ps b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
.ps__off { flex: none; width: 0.45rem; height: 0.45rem; border-radius: 50%; background: var(--fg-dimmer); }
.ps[data-stream='reconnecting'] .ps__off { background: var(--warn); }
.ps__txt { flex: 1; min-width: 0; }
.ps__stream { flex: none; color: var(--fg-dim); font-size: var(--fs-chrome); }
.ps[data-stream='reconnecting'] .ps__stream { color: var(--warn); }
.ps__last { flex: none; color: var(--accent); font-size: var(--fs-chrome); font-variant-numeric: tabular-nums; }
.ps__last[data-status='failed'] { color: var(--danger); }
.ps__last[data-status='superseded'] { color: var(--fg-dim); }
.ps__chev { flex: none; color: var(--fg-dimmer); font-size: var(--fs-body); }
.ps__sheet { display: flex; flex-direction: column; gap: 0.75rem; padding: 0 1rem; }
.ps__cap { display: flex; gap: 0.25rem; }
.ps__cap i { flex: 1; height: 0.4rem; border-radius: 2px; background: var(--panel-hi); }
.ps__cap i[data-cell='run'] { background: var(--accent); }
.ps__empty,
.ps__note { margin: 0; color: var(--fg-dim); font-size: var(--fs-chrome); }
</style>
