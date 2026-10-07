<script setup lang="ts">
import Disclosure from '@/features/inbox/Disclosure.vue';
import RunningList from '@/features/inbox/pipeline/RunningList.vue';
import type { PipelineSummary, RunningEntry } from '@/features/inbox/queue/build';

// «El pipeline» bajo 1100 px: una línea bajo el titular que se despliega con lo que corre. Arranca
// abierta si algo corre (como el mockup móvil: «Detener…» a la vista) y plegada si no. Los mismos
// números que el costado; nunca los dos a la vez. El chevron del plegable dice si está abierto.

defineProps<{ pipeline: PipelineSummary; running: RunningEntry[] }>();
</script>

<template>
  <Disclosure title="El pipeline" label :open="running.length > 0" data-test="pipeline-line" class="pl">
    <template #meta>
      <span><b class="mono">{{ pipeline.running }}</b> corriendo</span>
      <span><b class="mono">{{ pipeline.waiting }}</b> en cola</span>
      <span v-if="pipeline.free !== undefined">
        <b class="mono pl__free">{{ pipeline.free }}</b> {{ pipeline.free === 1 ? 'libre' : 'libres'
        }}<template v-if="pipeline.max !== undefined"> de {{ pipeline.max }}</template>
      </span>
    </template>
    <div class="pl__body">
      <RunningList v-if="running.length" :running="running" />
      <p class="pl__note">
        {{ pipeline.source === 'capacity' ? 'Cuenta ejecuciones, no tarjetas.' : 'Cuenta tarjetas: este runner no publica su capacidad.' }}
      </p>
    </div>
  </Disclosure>
</template>

<style scoped>
.pl b { color: var(--fg); font-weight: 700; font-variant-numeric: tabular-nums; }
.pl .pl__free { color: var(--accent); }
.pl__body { padding: 0 0.75rem 0.5rem; border-top: 1px solid var(--border-mute); }
.pl__note { margin: 0.35rem 0 0; color: var(--fg-dim); font-size: var(--fs-micro); }
</style>
