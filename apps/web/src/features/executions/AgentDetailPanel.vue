<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { type AgentDetail, fetchAgentDetail } from './api';

// Decomposition of one row of the health panel. The panel answers "which
// agent should I look at"; this answers "why did this one get worse", which
// the aggregate can't — an average is exactly what hides a regression.
const props = defineProps<{
  agentId: string;
  projectId?: string | null;
  windowDays: number;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'drill', payload: { agentId: string; failureClass: string }): void;
}>();

const detail = ref<AgentDetail | null>(null);
const loading = ref(false);
const error = ref('');

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const from = new Date(Date.now() - props.windowDays * 24 * 60 * 60 * 1000).toISOString();
    detail.value = await fetchAgentDetail(props.agentId, {
      from,
      ...(props.projectId ? { projectId: props.projectId } : {}),
    });
  } catch (err) {
    error.value = extractErrorMessage(err);
    detail.value = null;
  } finally {
    loading.value = false;
  }
}

watch(() => [props.agentId, props.projectId, props.windowDays], load, { immediate: true });

const versions = computed(() => detail.value?.byPromptVersion ?? []);
const failures = computed(() => detail.value?.recentFailures ?? []);
const days = computed(() => detail.value?.byDay ?? []);

// Only worth comparing versions when there is more than one AND at least two
// of them carry enough runs to mean anything. Otherwise the section would
// invite reading a 1-run "regression" as signal.
const COMPARABLE_MIN_RUNS = 3;
const versionsWorthComparing = computed(
  () => versions.value.filter((v) => v.runs >= COMPARABLE_MIN_RUNS).length >= 2,
);

// Difference between the two most recent comparable versions, so the headline
// says "-31 pts" instead of leaving the reader to subtract two percentages.
const versionDelta = computed(() => {
  const comparable = versions.value.filter(
    (v) => v.runs >= COMPARABLE_MIN_RUNS && v.successRate !== null,
  );
  if (comparable.length < 2) return null;
  const [current, previous] = comparable;
  return Math.round((current!.successRate! - previous!.successRate!) * 100);
});

const maxDayRuns = computed(() => Math.max(1, ...days.value.map((d) => d.runs)));

function percent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

function shortDate(iso: string): string {
  return iso.slice(5, 10);
}

function shortTime(iso: string): string {
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

const CLASS_LABELS: Record<string, string> = {
  tool_failure: 'tools fallando',
  no_op: 'sin trabajo',
  budget_exhausted: 'budget agotado',
  iteration_cap: 'tope de iteraciones',
  server_tool_pause: 'pausa server-tool',
  refusal: 'rechazo',
  infra_error: 'infra',
  cancelled: 'cancelado',
  unknown: 'sin clasificar',
};

function classLabel(cls: string | null): string {
  if (cls === null) return '—';
  return CLASS_LABELS[cls] ?? cls;
}
</script>

<template>
  <div class="detail-panel">
    <div class="detail-header">
      <h4>{{ agentId }}</h4>
      <button type="button" class="detail-close" @click="emit('close')">cerrar</button>
    </div>

    <p v-if="error" class="detail-error">{{ error }}</p>
    <p v-else-if="loading && !detail" class="detail-empty">Cargando…</p>
    <p v-else-if="!detail" class="detail-empty">
      Sin runs terminados de este agente en la ventana.
    </p>

    <template v-else>
      <!-- Prompt versions first: it's the only cut that turns "empeoró" into
           something attributable to a change someone actually made. -->
      <section class="detail-block">
        <h5>
          Por versión de prompt
          <span
            v-if="versionDelta !== null"
            class="delta"
            :class="versionDelta < 0 ? 'delta--down' : 'delta--up'"
          >
            {{ versionDelta > 0 ? '+' : '' }}{{ versionDelta }} pts vs. anterior
          </span>
        </h5>
        <p v-if="!versionsWorthComparing" class="block-note">
          Todavía no hay dos versiones con {{ COMPARABLE_MIN_RUNS }}+ runs para comparar.
        </p>
        <table class="detail-table">
          <tbody>
            <tr v-for="v in versions" :key="v.promptHash ?? 'none'">
              <td class="mono">{{ v.promptHash ?? 'sin versión' }}</td>
              <td class="num">{{ v.runs }} runs</td>
              <td class="num">{{ percent(v.successRate) }}</td>
              <td class="dim">{{ shortDate(v.firstSeen) }} → {{ shortDate(v.lastSeen) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="days.length > 0" class="detail-block">
        <h5>Runs por día</h5>
        <div class="spark">
          <div
            v-for="d in days"
            :key="d.day"
            class="spark-col"
            :title="`${d.day}: ${d.success}/${d.runs} ok`"
          >
            <div class="spark-bar" :style="{ height: `${(d.runs / maxDayRuns) * 100}%` }">
              <div
                class="spark-ok"
                :style="{ height: `${(d.success / Math.max(d.runs, 1)) * 100}%` }"
              ></div>
            </div>
            <span class="spark-label">{{ shortDate(d.day) }}</span>
          </div>
        </div>
      </section>

      <section v-if="failures.length > 0" class="detail-block">
        <h5>Últimos fallos</h5>
        <ul class="failure-list">
          <li v-for="f in failures" :key="f.id">
            <div class="failure-head">
              <button
                v-if="f.failureClass"
                type="button"
                class="class-chip"
                :title="`Filtrar el listado por ${f.failureClass}`"
                @click="emit('drill', { agentId, failureClass: f.failureClass })"
              >
                {{ classLabel(f.failureClass) }}
              </button>
              <span v-else class="class-chip class-chip--muted">{{ f.outcome }}</span>
              <span class="failure-title">{{ f.taskTitle }}</span>
              <span class="failure-time">{{ shortTime(f.startedAt) }}</span>
            </div>
            <p v-if="f.errorExcerpt" class="failure-msg">{{ f.errorExcerpt }}</p>
            <p v-else-if="f.stopReason" class="failure-msg dim">stop_reason: {{ f.stopReason }}</p>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.detail-panel {
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  padding: 0.75rem 0.9rem;
  margin: 0.5rem 0 0.9rem;
  background: var(--panel);
}
.detail-header { display: flex; justify-content: space-between; align-items: center; }
.detail-header h4 { margin: 0; font-size: 0.88rem; font-family: var(--font-mono, monospace); }
.detail-close {
  border: 1px solid var(--border-hi);
  background: transparent;
  color: var(--fg-dim);
  border-radius: 999px;
  padding: 0 0.5rem;
  font-size: 0.72rem;
  cursor: pointer;
}
.detail-error { font-size: 0.8rem; color: var(--danger); margin: 0.5rem 0 0; }
.detail-empty { font-size: 0.8rem; color: var(--fg-dim); margin: 0.5rem 0 0; }
.detail-block { margin-top: 0.85rem; }
.detail-block h5 {
  margin: 0 0 0.35rem;
  font-size: 0.78rem;
  color: var(--fg-mute);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.block-note { margin: 0 0 0.35rem; font-size: 0.74rem; color: var(--fg-dim); }
.delta { font-size: 0.72rem; border-radius: 999px; padding: 0 0.4rem; font-weight: 600; }
.delta--down { background: var(--danger); color: var(--panel); }
.delta--up { background: var(--accent); color: var(--panel); }

.detail-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
.detail-table td { padding: 0.2rem 0.4rem; border-bottom: 1px solid var(--border); }
.detail-table .num { text-align: right; white-space: nowrap; }
.mono { font-family: var(--font-mono, monospace); }
.dim { color: var(--fg-dim); }

.spark { display: flex; align-items: flex-end; gap: 3px; height: 60px; }
.spark-col { display: flex; flex-direction: column; align-items: center; flex: 1; height: 100%; }
.spark-bar {
  width: 100%;
  min-height: 2px;
  background: var(--danger);
  border-radius: 2px 2px 0 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  margin-top: auto;
}
.spark-ok { width: 100%; background: var(--accent); border-radius: 0 0 2px 2px; }
.spark-label { font-size: 0.62rem; color: var(--fg-dim); margin-top: 2px; }

.failure-list { list-style: none; margin: 0; padding: 0; }
.failure-list li { border-bottom: 1px solid var(--border); padding: 0.35rem 0; }
.failure-head { display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap; }
.failure-title { font-size: 0.78rem; flex: 1; min-width: 0; }
.failure-time { font-size: 0.72rem; color: var(--fg-dim); }
.failure-msg {
  margin: 0.2rem 0 0;
  font-size: 0.72rem;
  color: var(--fg-dim);
  font-family: var(--font-mono, monospace);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.class-chip {
  border: 1px solid var(--border-hi);
  background: transparent;
  color: var(--fg-dim);
  border-radius: 999px;
  padding: 0 0.45rem;
  font-size: 0.7rem;
  cursor: pointer;
}
.class-chip:hover { border-color: var(--accent); color: var(--accent); }
.class-chip--muted { cursor: default; }
</style>
