<script setup lang="ts">
import type { ExecutionSummary, TraceEntry } from '@ia-flow/shared';
import { computed, nextTick, ref, watch } from 'vue';
import { formatRelative } from '@/composables/formatRelative';
import { duration, executionStatus, traceLine, usageLine } from '@/features/inbox/format';
import ActionError from '@/features/inbox/decisions/ActionError.vue';
import Disclosure from '@/features/inbox/Disclosure.vue';
import { loadFailure } from '@/features/inbox/queue/advice';
import LogLine from '@/ui/LogLine.vue';

// Una ejecución de la tarea. Plegada, una línea: quién corrió, cómo terminó y
// cuándo (si falló, quién la cortó, sin el error); abierta, sus datos, el error crudo UNA vez
// —plegado en «Detalle técnico»— y la traza. La traza la trae
// quien la usa (`TaskExecutions`): la de la ejecución viva llega por el stream.

const props = defineProps<{
  execution: ExecutionSummary;
  open: boolean;
  trace: TraceEntry[];
  loading?: boolean;
  error?: string | null;
  /** Recién saltó acá desde un evento: se resalta un instante. */
  flash?: boolean;
}>();
const emit = defineEmits<{ (e: 'toggle'): void; (e: 'retry'): void }>();

const GLYPH: Record<ExecutionSummary['status'], string> = {
  running: '●',
  paused: '‖',
  done: '✓',
  failed: '✕',
  superseded: '↷',
};

const live = computed(() => props.execution.status === 'running');
const traceFailure = computed(() => (props.error ? loadFailure('cargar la traza', props.error) : null));
const failedBy = computed(() => (props.execution.failure?.by === 'agent' ? 'la cortó el agente' : 'falló el runner'));
const took = computed(() => {
  const { started_at, closed_at } = props.execution;
  if (!closed_at) return null;
  return duration(Date.parse(closed_at) - Date.parse(started_at));
});

// La traza viva sigue la última línea, como un log — salvo que se haya subido a leer.
const log = ref<HTMLElement | null>(null);
watch(
  () => props.trace.length,
  async () => {
    const box = log.value;
    const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    await nextTick();
    if (atBottom && log.value) log.value.scrollTop = log.value.scrollHeight;
  },
);
</script>

<template>
  <li class="xr" :data-status="execution.status" :data-flash="flash || undefined">
    <button
      type="button"
      class="xr__row"
      :aria-expanded="open"
      :aria-controls="`xr-${execution.id}`"
      :data-test="`execution-${execution.id}`"
      @click="emit('toggle')"
    >
      <span class="xr__glyph" :title="executionStatus(execution.status)" aria-hidden="true">{{ GLYPH[execution.status] }}</span>
      <span class="xr__main">
        <span class="xr__line">
          <span class="xr__agent">{{ execution.agent_id ?? execution.pipeline_id }}</span>
          <span v-if="execution.agent_id" class="xr__dim mono">{{ execution.pipeline_id }}</span>
          <span class="xr__dim mono">{{ execution.id.slice(0, 8) }}</span>
          <span v-if="live" class="xr__live"><span class="live-dot" aria-hidden="true" />en curso</span>
          <span v-else class="xr__status">{{ executionStatus(execution.status) }}</span>
        </span>
        <span v-if="execution.failure" class="xr__err">✕ {{ failedBy }}</span>
        <span v-else-if="execution.exit" class="xr__dim">salida <span class="mono">{{ execution.exit }}</span></span>
      </span>
      <span class="xr__side">
        <span>{{ formatRelative(execution.started_at) }} <span class="xr__chev" aria-hidden="true">›</span></span>
        <span v-if="took">{{ took }}</span>
      </span>
    </button>

    <div v-if="open" :id="`xr-${execution.id}`" class="xr__body">
      <p class="xr__facts">
        <span v-if="execution.usage" class="mono">{{ usageLine(execution.usage) }}</span>
        <span v-if="execution.close_reason">cerró: {{ execution.close_reason }}</span>
        <span v-if="execution.pause">
          pausada <span class="mono">{{ execution.pause.pause_id }}</span
          ><template v-if="execution.pause.expires_at"> · vence {{ formatRelative(execution.pause.expires_at) }}</template>
        </span>
      </p>
      <Disclosure v-if="execution.failure" title="Detalle técnico" tag="span" data-test="tech">
        <pre class="xr__pre mono">{{ execution.failure.message }}</pre>
      </Disclosure>
      <p v-if="loading" class="xr__dim">· cargando la traza…</p>
      <ActionError v-else-if="traceFailure" :failure="traceFailure" @retry="emit('retry')" />
      <div v-else-if="trace.length" ref="log" class="xr__log" role="log" :aria-label="`Traza de ${execution.id}`">
        <LogLine v-for="(entry, i) in trace" :key="`${entry.span_id}-${entry.kind}-${entry.phase ?? ''}-${i}`" v-bind="traceLine(entry)" />
      </div>
      <p v-else class="xr__dim">· sin traza registrada</p>
    </div>
  </li>
</template>

<style scoped>
.xr + .xr { border-top: 1px solid var(--border-mute); }
.xr[data-flash] { animation: xr-flash 1.2s ease-out; }
@keyframes xr-flash { from { background: var(--panel-hi); } to { background: transparent; } }
/* La fila entera es el blanco táctil (R1). */
.xr__row {
  display: grid;
  grid-template-columns: 1.1rem minmax(0, 1fr) auto;
  gap: 0.1rem 0.6rem;
  align-items: start;
  width: 100%;
  min-height: var(--tap-h);
  padding: 0.5rem 0.75rem;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.xr__row:hover { background: var(--panel-alt); }
.xr__row:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.xr__glyph { font-family: var(--font-mono); line-height: 1.45; color: var(--fg-dim); }
.xr[data-status='failed'] .xr__glyph { color: var(--danger); }
.xr[data-status='running'] .xr__glyph { color: var(--accent); }
.xr[data-status='paused'] .xr__glyph { color: var(--warn); }
.xr__main { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
.xr__line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.6rem; font-size: var(--fs-body-sm); }
.xr__agent { color: var(--fg); font-weight: 600; }
.xr__status { color: var(--fg-dim); font-size: var(--fs-micro); }
.xr__live { display: inline-flex; align-items: center; gap: 0.35rem; color: var(--accent); font-family: var(--font-mono); font-size: var(--fs-micro); }
/* Plegada, sólo quién la cortó; el error crudo va una vez, abajo, en «Detalle técnico». */
.xr__err { color: var(--danger); font-size: var(--fs-micro); }
.xr__pre { margin: 0; padding: 0 0.75rem 0.75rem; color: var(--fg-mute); font-size: var(--fs-micro); line-height: 1.55; white-space: pre-wrap; word-break: break-all; max-height: 20rem; overflow-y: auto; }
.xr__dim { color: var(--fg-dim); font-size: var(--fs-body-sm); }
.xr__side { display: flex; flex-direction: column; align-items: flex-end; gap: 0.1rem; color: var(--fg-dim); font-size: var(--fs-micro); font-variant-numeric: tabular-nums; white-space: nowrap; }
.xr__chev { display: inline-block; transition: transform 120ms ease; }
.xr__row[aria-expanded='true'] .xr__chev { transform: rotate(90deg); }
.xr__body { display: flex; flex-direction: column; gap: 0.5rem; padding: 0 0.75rem 0.75rem 2.45rem; }
.xr__body p { margin: 0; }
.xr__facts { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; color: var(--fg-dim); font-size: var(--fs-micro); }
/* Sin scroll horizontal (R2): la línea de log ya se trunca sola. */
.xr__log { max-height: 28rem; overflow-x: hidden; overflow-y: auto; padding: 0.25rem 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); }
@media (prefers-reduced-motion: reduce) {
  .xr[data-flash], .xr__live .live-dot { animation: none; }
  .xr__chev { transition: none; }
}
</style>
