<script setup lang="ts">
import type { ExecutionSummary, TraceEntry } from '@ia-flow/shared';
import { computed, nextTick, ref, watch } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { getTaskDetail } from '@/features/inbox/api';
import ExecutionRow from '@/features/inbox/ExecutionRow.vue';

// Las ejecuciones de la tarea, la más nueva primero. Plegadas se leen de un
// vistazo; arranca abierta la que corre o, si no hay, la última que falló. La
// traza de la que trae el detalle (`liveTrace`, la última) llega en vivo por el
// stream; la de cualquier otra se pide al abrirla y queda: una ejecución
// cerrada no cambia.

interface TraceState {
  loading: boolean;
  error: string | null;
  entries: TraceEntry[];
}

const props = defineProps<{
  taskRef: string;
  executions: ExecutionSummary[];
  /** La traza que trae el detalle: la de su última ejecución, en vivo. */
  liveTrace: TraceEntry[];
  /** Abrir y resaltar esta ejecución (un evento pidió verla). Cada pedido trae su `at`. */
  focus?: { id: string; at: number } | null;
}>();

/** La ejecución dueña de `liveTrace`: la de sus líneas o, sin líneas, la última. */
const liveId = computed(() => props.liveTrace[0]?.execution_id ?? props.executions[0]?.id);

function defaultOpen(executions: ExecutionSummary[]): string | undefined {
  const running = executions.find((e) => e.status === 'running' || e.status === 'paused');
  return (running ?? executions.find((e) => e.status === 'failed'))?.id;
}

const opened = ref(new Set<string>());
const traces = ref<Record<string, TraceState>>({});
const flashed = ref<string | null>(null);

// Una tarea nueva arranca con lo de siempre abierto; la misma, conserva lo que abrió la persona.
watch(
  () => props.taskRef,
  () => {
    const first = defaultOpen(props.executions);
    opened.value = new Set(first ? [first] : []);
    traces.value = {};
    if (first) void load(first);
  },
  { immediate: true },
);

// Una ejecución que arranca con el panel abierto se abre sola: es la que se viene a mirar.
watch(
  () => props.executions[0],
  (latest, previous) => {
    if (!latest || latest.id === previous?.id || latest.status !== 'running') return;
    opened.value = new Set([...opened.value, latest.id]);
  },
);

async function load(id: string): Promise<void> {
  if (id === liveId.value) return;
  const prev = traces.value[id];
  if (prev && (prev.loading || !prev.error)) return;
  traces.value = { ...traces.value, [id]: { loading: true, error: null, entries: [] } };
  try {
    const detail = await getTaskDetail(props.taskRef, id);
    traces.value = { ...traces.value, [id]: { loading: false, error: null, entries: detail.trace } };
  } catch (err) {
    traces.value = { ...traces.value, [id]: { loading: false, error: extractErrorMessage(err), entries: [] } };
  }
}

function toggle(id: string): void {
  const next = new Set(opened.value);
  if (next.has(id)) next.delete(id);
  else {
    next.add(id);
    void load(id);
  }
  opened.value = next;
}

function traceOf(id: string): TraceState {
  if (id === liveId.value) return { loading: false, error: null, entries: props.liveTrace };
  return traces.value[id] ?? { loading: false, error: null, entries: [] };
}

const list = ref<HTMLElement | null>(null);
watch(
  () => props.focus,
  async (focus) => {
    if (!focus || !props.executions.some((e) => e.id === focus.id)) return;
    if (!opened.value.has(focus.id)) toggle(focus.id);
    flashed.value = null;
    await nextTick();
    flashed.value = focus.id;
    const row = list.value?.querySelector<HTMLElement>(`[data-test="execution-${focus.id}"]`);
    row?.scrollIntoView({ block: 'center' });
    row?.focus({ preventScroll: true });
  },
);
</script>

<template>
  <section v-if="executions.length" class="tx" aria-labelledby="tx-head">
    <span id="tx-head" class="uc-label">ejecuciones · {{ executions.length }}</span>
    <ul ref="list" class="tx__list">
      <ExecutionRow
        v-for="execution in executions"
        :key="execution.id"
        :execution="execution"
        :open="opened.has(execution.id)"
        :trace="traceOf(execution.id).entries"
        :loading="traceOf(execution.id).loading"
        :error="traceOf(execution.id).error"
        :flash="flashed === execution.id"
        @toggle="toggle(execution.id)"
        @retry="load(execution.id)"
      />
    </ul>
  </section>
</template>

<style scoped>
.tx { display: flex; flex-direction: column; gap: 0.4rem; }
.tx__list { margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
</style>
