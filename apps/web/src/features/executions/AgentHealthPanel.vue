<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { type ExecutionStats, fetchExecutionStats } from './api';
import {
  CLASS_LABELS,
  compactTokens,
  duration,
  formatUsd,
  percent,
  WINDOWS,
} from './health-format';

// Per-agent health over a time window. Separate from the run list on purpose:
// the list answers "what happened in this run", this answers "is this agent
// healthy", and those need different windows — a rate computed from the
// list's capped page describes the page, not the agent.
const props = defineProps<{ projectId?: string | null }>();

const emit = defineEmits<{
  // Emitted when a failure class is clicked, so the surrounding run list can
  // filter down to the runs behind a number instead of leaving the user to
  // reconstruct the query by hand.
  (e: 'drill', payload: { agentId: string; failureClass: string }): void;
  // Una fila es un link a la página del agente. La navegación la hace el
  // padre, que es quien sabe en qué ruta estamos: el panel no conoce el
  // router ni el scope.
  (e: 'open', agentId: string): void;
}>();

const windowDays = ref<number>(7);
const stats = ref<ExecutionStats | null>(null);
const loading = ref(false);
const error = ref('');

// Agents with very few runs in the window: their rate is technically correct
// and practically meaningless, so the panel shows the count instead of
// implying a trend.
const LOW_SAMPLE = 5;

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const from = new Date(Date.now() - windowDays.value * 24 * 60 * 60 * 1000).toISOString();
    stats.value = await fetchExecutionStats({
      from,
      ...(props.projectId ? { projectId: props.projectId } : {}),
    });
  } catch (err) {
    error.value = extractErrorMessage(err);
    stats.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => [props.projectId, windowDays.value], load);

const agents = computed(() => stats.value?.agents ?? []);
const totals = computed(() => stats.value?.totals ?? null);

// Three bands, not a gradient: the panel exists to make "which agent should I
// look at" answerable at a glance, and a continuous colour scale makes every
// agent look equally mid.
function healthClass(agent: { successRate: number | null; runs: number }): string {
  if (agent.successRate === null || agent.runs < LOW_SAMPLE) return 'health--unknown';
  if (agent.successRate >= 0.9) return 'health--good';
  if (agent.successRate >= 0.6) return 'health--warn';
  return 'health--bad';
}

function classLabel(cls: string): string {
  return CLASS_LABELS[cls] ?? cls;
}

function sortedClasses(classes: Record<string, number>): Array<[string, number]> {
  return Object.entries(classes).sort((a, b) => b[1] - a[1]);
}

// ─── Eficiencia ──────────────────────────────────────────────────────────
// Estas columnas responden "por qué este agente cuesta lo que cuesta", que
// el total de tokens no distingue: un agente caro puede serlo porque trabaja
// mucho o porque paga mal cada vuelta. El costo en dólares es lo que las
// vuelve comparables entre agentes con modelos distintos.

// Bandas del cache hit. Un prefijo estable (system + tools) debería servirse
// casi entero del cache; por debajo de 0.5 el historial se está re-mandando a
// precio pleno en cada vuelta.
const CACHE_GOOD = 0.85;
const CACHE_WARN = 0.5;

function cacheClass(rate: number | null): string {
  if (rate === null) return 'health--unknown';
  if (rate >= CACHE_GOOD) return 'health--good';
  if (rate >= CACHE_WARN) return 'health--warn';
  return 'health--bad';
}

// El total y la salida viven acá y no en una columna: son lo que se consulta
// de vez en cuando, no lo que ordena la tabla.
function cacheTitle(agent: {
  cacheHitRate: number | null;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): string {
  if (agent.cacheHitRate === null) {
    return 'Sin tokens observables — los runs de terminal sin transcripción no los reportan.';
  }
  const total =
    agent.tokensIn + agent.cacheReadTokens + agent.cacheCreationTokens + agent.tokensOut;
  return (
    `${compactTokens(agent.cacheReadTokens)} desde cache · ` +
    `${compactTokens(agent.tokensIn)} frescos (precio pleno) · ` +
    `${compactTokens(agent.cacheCreationTokens)} escritos al cache · ` +
    `${compactTokens(agent.tokensOut)} de salida · ` +
    `${compactTokens(total)} en total`
  );
}

function costTitle(agent: { costUsd: number | null; models: Record<string, number>; runs: number }): string {
  if (agent.costUsd === null) {
    return 'Sin modelo observado en la ventana — no se puede tasar.';
  }
  const perRun = agent.runs > 0 ? formatUsd(agent.costUsd / agent.runs) : '—';
  const models = Object.entries(agent.models)
    .map(([m, n]) => `${m} · ${n}`)
    .join(', ');
  return `${perRun} por run · precio de lista de ${models}`;
}

// Tokens frescos por vuelta del loop. Es el discriminante: muchas vueltas
// baratas es un agente que trabaja; pocas vueltas carísimas es un historial
// que se re-manda sin cachear.
function freshPerIter(agent: { tokensIn: number; iters: number }): number | null {
  return agent.iters > 0 ? agent.tokensIn / agent.iters : null;
}

function itersPerRun(agent: { iters: number; runs: number }): string {
  if (agent.iters === 0 || agent.runs === 0) return '—';
  return (agent.iters / agent.runs).toFixed(1);
}

// `max_tokens` es el único stop reason que nombra una causa accionable
// (subir maxTokens, o acortar el trabajo por run). El resto es ruido en una
// tabla que ya tiene la columna de fallos.
function budgetStops(stopReasons: Record<string, number>): number {
  return stopReasons.max_tokens ?? 0;
}

function modelCount(models: Record<string, number>): number {
  return Object.keys(models).length;
}
</script>

<template>
  <div class="health-panel">
    <div class="health-header">
      <div>
        <h3>Salud por agente</h3>
        <p class="health-desc">
          Runs terminados en la ventana. La tasa se calcula en el servidor sobre
          todo el período, no sobre la página del listado. Una fila abre la página del agente.
        </p>
      </div>
      <div class="window-chips">
        <button
          v-for="w in WINDOWS"
          :key="w.days"
          type="button"
          class="window-chip"
          :class="{ 'window-chip--on': windowDays === w.days }"
          :aria-pressed="windowDays === w.days"
          @click="windowDays = w.days"
        >
          {{ w.label }}
        </button>
      </div>
    </div>

    <p v-if="error" class="health-error">{{ error }}</p>
    <p v-else-if="loading && !stats" class="health-empty">Cargando…</p>
    <p v-else-if="agents.length === 0" class="health-empty">
      Sin ejecuciones terminadas en esta ventana.
    </p>

    <template v-else>
      <p v-if="totals" class="health-totals">
        <strong>{{ totals.runs }}</strong> runs ·
        <strong>{{ percent(totals.successRate) }}</strong> ok ·
        {{ compactTokens(totals.tokensIn) }} frescos ·
        <strong :class="cacheClass(totals.cacheHitRate)">
          {{ percent(totals.cacheHitRate) }}
        </strong> cache ·
        <strong>{{ formatUsd(totals.costUsd) }}</strong> est.
      </p>

      <div class="health-table-wrap">
      <table class="health-table">
        <thead>
          <tr>
            <th>Agente</th>
            <th class="num">Ejecuciones</th>
            <th class="num">Éxito</th>
            <th class="num" title="Promedio · p95 — el p95 marca el outlier que el promedio diluye">
              Duración
            </th>
            <th class="num">Tools</th>
            <th class="num" title="Vueltas del loop de tools por run">Iters</th>
            <th class="num" title="Tokens de entrada frescos — los que se pagan a precio pleno">
              Frescos
            </th>
            <th class="num" title="Fracción de la entrada servida desde el cache de prompts">
              Cache
            </th>
            <th class="num" title="Costo estimado a precio de lista del modelo de cada run">
              Costo
            </th>
            <th>Fallos</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="agent in agents"
            :key="agent.agentId"
            class="agent-row"
            tabindex="0"
            role="link"
            :title="`Abrir la página de ${agent.agentId}`"
            @click="emit('open', agent.agentId)"
            @keydown.enter.prevent="emit('open', agent.agentId)"
            @keydown.space.prevent="emit('open', agent.agentId)"
          >
            <td class="agent-cell">
              {{ agent.agentId }}
              <span
                v-if="agent.promptVersions > 1"
                class="prompt-warn"
                :title="`La config del agente cambió ${agent.promptVersions} veces en esta ventana — la tasa mezcla versiones distintas del agente.`"
              >
                {{ agent.promptVersions }} versiones
              </span>
              <span
                v-if="agent.systemPromptVersions > 1"
                class="prompt-warn"
                :title="`Cambió un system prompt ${agent.systemPromptVersions} veces en la ventana — un system prompt es compartido, así que afecta a más agentes que éste.`"
              >
                {{ agent.systemPromptVersions }} system
              </span>
              <span
                v-if="modelCount(agent.models) > 1"
                class="model-warn"
                :title="`Corrió con ${modelCount(agent.models)} modelos distintos — sus tokens promedian precios distintos.`"
              >
                {{ modelCount(agent.models) }} modelos
              </span>
            </td>
            <td class="num">{{ agent.runs }}</td>
            <td class="num">
              <span class="health-badge" :class="healthClass(agent)">
                {{ percent(agent.successRate) }}
              </span>
            </td>
            <td class="num">
              {{ duration(agent.avgDurationMs) }}
              <span
                v-if="agent.p95DurationMs !== null && agent.p95DurationMs !== agent.avgDurationMs"
                class="sub-metric"
                :title="`p95: el 5% más lento arranca en ${duration(agent.p95DurationMs)}`"
              >
                p95 {{ duration(agent.p95DurationMs) }}
              </span>
            </td>
            <td class="num">
              {{ agent.toolCalls || '—' }}
              <span v-if="agent.toolErrors > 0" class="tool-errors">
                / {{ agent.toolErrors }} err
              </span>
            </td>
            <td class="num">
              {{ itersPerRun(agent) }}
              <span
                v-if="budgetStops(agent.stopReasons) > 0"
                class="tool-errors"
                :title="`${budgetStops(agent.stopReasons)} runs cortados por max_tokens — se quedaron sin presupuesto`"
              >
                / {{ budgetStops(agent.stopReasons) }} budget
              </span>
            </td>
            <td class="num">
              {{ compactTokens(agent.tokensIn) }}
              <span
                v-if="freshPerIter(agent) !== null"
                class="sub-metric"
                title="Tokens frescos por vuelta del loop — si crece con las iteraciones, el historial no se está cacheando"
              >
                {{ compactTokens(Math.round(freshPerIter(agent)!)) }}/iter
              </span>
            </td>
            <td class="num">
              <span
                class="health-badge"
                :class="cacheClass(agent.cacheHitRate)"
                :title="cacheTitle(agent)"
              >
                {{ percent(agent.cacheHitRate) }}
              </span>
            </td>
            <td class="num cost-cell" :title="costTitle(agent)">
              {{ formatUsd(agent.costUsd) }}
            </td>
            <td>
              <span v-if="sortedClasses(agent.failureClasses).length === 0" class="dash">—</span>
              <button
                v-for="[cls, n] in sortedClasses(agent.failureClasses)"
                :key="cls"
                type="button"
                class="class-chip"
                :title="`Ver los ${n} runs de ${agent.agentId} con fallo ${cls}`"
                @click.stop="emit('drill', { agentId: agent.agentId, failureClass: cls })"
              >
                {{ classLabel(cls) }} · {{ n }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.health-panel {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.85rem 1rem;
  margin-bottom: 1rem;
  background: var(--panel-hi);
}
.health-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  flex-wrap: wrap;
}
.health-header h3 { margin: 0; font-size: var(--fs-body); }
.health-desc { margin: 0.25rem 0 0.6rem; font-size: var(--fs-chrome); color: var(--fg-dim); line-height: 1.45; }
.window-chips { display: flex; gap: 0.3rem; }
.window-chip {
  border: 1px solid var(--border-hi);
  background: transparent;
  color: var(--fg-dim);
  border-radius: var(--radius-sm);
  padding: 0.15rem 0.6rem;
  font-size: var(--fs-chrome);
  cursor: pointer;
}
.window-chip--on { background: var(--accent); color: var(--panel); border-color: var(--accent); }
.health-error { font-size: var(--fs-body-sm); color: var(--danger); margin: 0.4rem 0 0; }
.health-empty { font-size: var(--fs-body-sm); color: var(--fg-dim); margin: 0.4rem 0 0; }
.health-totals { font-size: var(--fs-body-sm); color: var(--fg-dim); margin: 0 0 0.6rem; }

/* Una tabla de verdad: comparar agentes entre filas es para lo que existe, así
   que no se apila. Scrollea dentro de su caja para que la PÁGINA no scrollee —
   en un celular medía 593px contra 390 de pantalla. */
.health-table-wrap { overflow-x: auto; }
.health-table { width: 100%; border-collapse: collapse; font-size: var(--fs-body-sm); }
@media (max-width: 768px) { .health-table { min-width: 38rem; } }
.health-table th {
  text-align: left;
  font-weight: 600;
  color: var(--fg-mute);
  border-bottom: 1px solid var(--border);
  padding: 0.3rem 0.4rem;
}
.health-table td { padding: 0.35rem 0.4rem; border-bottom: 1px solid var(--border); vertical-align: top; }
.health-table .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.health-table th.num { text-align: right; }
.agent-cell { font-family: var(--font-mono); }
.prompt-warn,
.model-warn {
  display: inline-block;
  margin-left: 0.4rem;
  font-family: var(--font-body);
  font-size: var(--fs-micro);
  border-radius: var(--radius-sm);
  padding: 0 0.35rem;
  cursor: help;
}
.prompt-warn { color: var(--warn); border: 1px solid var(--warn); }
.model-warn { color: var(--info); border: 1px solid var(--info); }
.health-badge { border-radius: var(--radius-sm); padding: 0.05rem 0.45rem; font-weight: 600; }
.health--good { background: var(--accent); color: var(--panel); }
.health--warn { background: var(--warn); color: var(--panel); }
.health--bad { background: var(--danger); color: var(--panel); }
.health--unknown { background: var(--border); color: var(--fg-mute); }
.sub-metric {
  display: block;
  font-size: 0.75em;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}
.cost-cell { cursor: help; }

.tool-errors { color: var(--danger); font-size: var(--fs-micro); }
.agent-row { cursor: pointer; }
.agent-row:hover td { background: var(--panel); }
.agent-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.dash { color: var(--fg-mute); }
.class-chip {
  display: inline-block;
  margin: 0 0.25rem 0.2rem 0;
  border: 1px solid var(--border-hi);
  background: transparent;
  color: var(--fg-dim);
  border-radius: var(--radius-sm);
  padding: 0.05rem 0.45rem;
  font-size: var(--fs-micro);
  cursor: pointer;
}
.class-chip:hover { border-color: var(--accent); color: var(--accent); }
</style>
