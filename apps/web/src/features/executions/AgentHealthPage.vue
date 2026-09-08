<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { type AgentDetail, fetchAgentDetail } from './api';
import {
  CLASS_LABELS,
  compactTokens,
  duration,
  formatUsd,
  percent,
  WINDOWS,
} from './health-format';

// La página de un agente. El panel de salud contesta "a cuál mirar"; esto
// contesta "por qué cuesta lo que cuesta y qué cambió", que el agregado no
// puede — un promedio es exactamente lo que esconde una regresión.
//
// Es una página y no una fila colapsable a propósito: tiene cuatro cortes
// (versiones, system prompts, tools, modelos) que apilados dentro de una tabla
// la volvían una pared de números, y una URL propia se comparte y se vuelve
// a abrir.
const props = defineProps<{
  agentId: string;
  projectId?: string | null;
  /** Ruta al editor del agente, para el link del header. La arma quien sabe
   *  en qué scope estamos; esta feature no importa la de agentes. */
  editorPath?: string | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'drill', payload: { agentId: string; failureClass: string }): void;
}>();

const windowDays = ref<number>(7);
const detail = ref<AgentDetail | null>(null);
const loading = ref(false);
const error = ref('');

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const from = new Date(Date.now() - windowDays.value * 24 * 60 * 60 * 1000).toISOString();
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

watch(() => [props.agentId, props.projectId, windowDays.value], load, { immediate: true });

const health = computed(() => detail.value?.health ?? null);
const versions = computed(() => detail.value?.byPromptVersion ?? []);
const systemVersions = computed(() => detail.value?.bySystemPromptVersion ?? []);
const failures = computed(() => detail.value?.recentFailures ?? []);
const days = computed(() => detail.value?.byDay ?? []);

// Sólo vale comparar versiones cuando hay más de una Y al menos dos con runs
// suficientes. Si no, la sección invita a leer una "regresión" de 1 run
// como señal.
const COMPARABLE_MIN_RUNS = 3;
const versionsWorthComparing = computed(
  () => versions.value.filter((v) => v.runs >= COMPARABLE_MIN_RUNS).length >= 2,
);
const versionDelta = computed(() => {
  const comparable = versions.value.filter(
    (v) => v.runs >= COMPARABLE_MIN_RUNS && v.successRate !== null,
  );
  if (comparable.length < 2) return null;
  const [current, previous] = comparable;
  return Math.round((current!.successRate! - previous!.successRate!) * 100);
});

// Cruce de los dos hashes: es la lectura que motiva tener ambos. Si cambió el
// del agente y no el del system prompt, la edición fue en el agente; si cambió
// el del system prompt, fue en un prompt compartido y afecta a todo el roster.
const versionReading = computed(() => {
  const h = health.value;
  if (!h) return '';
  if (h.promptVersions > 1 && h.systemPromptVersions <= 1) {
    return 'El agente cambió en la ventana; sus system prompts no. La diferencia entre versiones es de este agente.';
  }
  if (h.systemPromptVersions > 1) {
    return 'Cambió un system prompt en la ventana. Un system prompt es compartido: lo que se vea acá probablemente se vea en otros agentes también.';
  }
  return '';
});

const tools = computed(() =>
  Object.entries(health.value?.toolBreakdown ?? {})
    .map(([name, t]) => ({ name, calls: t.calls, errors: t.errors }))
    .sort((a, b) => b.calls - a.calls),
);
const maxToolCalls = computed(() => Math.max(1, ...tools.value.map((t) => t.calls)));

const models = computed(() =>
  Object.entries(health.value?.models ?? {}).sort((a, b) => b[1] - a[1]),
);

const maxDayRuns = computed(() => Math.max(1, ...days.value.map((d) => d.runs)));

function perRun(total: number, runs: number): string {
  return runs > 0 ? (total / runs).toFixed(1) : '—';
}

function costPerRun(cost: number | null, runs: number): string {
  if (cost === null || runs === 0) return '—';
  return formatUsd(cost / runs);
}

function shortDate(iso: string): string {
  return iso.slice(5, 10);
}

function shortTime(iso: string): string {
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

function classLabel(cls: string | null): string {
  if (cls === null) return '—';
  return CLASS_LABELS[cls] ?? cls;
}

function itersPerRun(): string {
  const h = health.value;
  if (!h || h.iters === 0 || h.runs === 0) return '—';
  return (h.iters / h.runs).toFixed(1);
}
</script>

<template>
  <section class="agent-page">
    <header class="agent-page__header">
      <div class="agent-page__title">
        <button type="button" class="btn btn--ghost" @click="emit('close')">← Ejecuciones</button>
        <h2 class="mono">{{ agentId }}</h2>
        <RouterLink v-if="editorPath" :to="editorPath" class="agent-page__editor">
          Editar agente
        </RouterLink>
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
    </header>

    <p v-if="error" class="agent-page__error">{{ error }}</p>
    <p v-else-if="loading && !detail" class="agent-page__empty">Cargando…</p>
    <p v-else-if="!detail || !health" class="agent-page__empty">
      Sin runs terminados de este agente en la ventana.
    </p>

    <template v-else>
      <!-- Resumen: los mismos números de la fila del panel, para que la
           página arranque donde la tabla terminó. -->
      <div class="tiles">
        <div class="tile">
          <span class="uc-label">Runs</span>
          <strong>{{ health.runs }}</strong>
        </div>
        <div class="tile">
          <span class="uc-label">Éxito</span>
          <strong>{{ percent(health.successRate) }}</strong>
        </div>
        <div class="tile">
          <span class="uc-label">Duración</span>
          <strong>{{ duration(health.avgDurationMs) }}</strong>
          <span v-if="health.p95DurationMs !== null" class="tile__sub">p95 {{ duration(health.p95DurationMs) }}</span>
        </div>
        <div class="tile">
          <span class="uc-label">Costo est.</span>
          <strong>{{ formatUsd(health.costUsd) }}</strong>
          <span class="tile__sub">{{ costPerRun(health.costUsd, health.runs) }} por run</span>
        </div>
        <div class="tile">
          <span class="uc-label">Cache</span>
          <strong>{{ percent(health.cacheHitRate) }}</strong>
          <span class="tile__sub">{{ compactTokens(health.cacheReadTokens) }} desde cache</span>
        </div>
        <div class="tile">
          <span class="uc-label">Iters / run</span>
          <strong>{{ itersPerRun() }}</strong>
          <span class="tile__sub">{{ compactTokens(health.tokensIn) }} frescos</span>
        </div>
        <div class="tile">
          <span class="uc-label">Tools</span>
          <strong>{{ health.toolCalls || '—' }}</strong>
          <span v-if="health.toolErrors > 0" class="tile__sub tile__sub--bad">{{ health.toolErrors }} con error</span>
        </div>
      </div>

      <p class="tokens-line">
        Entrada: <span class="mono">{{ compactTokens(health.tokensIn) }}</span> frescos ·
        <span class="mono">{{ compactTokens(health.cacheReadTokens) }}</span> desde cache ·
        <span class="mono">{{ compactTokens(health.cacheCreationTokens) }}</span> escritos al cache.
        Salida: <span class="mono">{{ compactTokens(health.tokensOut) }}</span>.
        <template v-if="models.length > 0">
          Modelo:
          <span v-for="[model, runs] in models" :key="model" class="model-chip mono">{{ model }} · {{ runs }}</span>
        </template>
        <template v-else>Sin modelo observado: el costo no se puede estimar.</template>
      </p>

      <!-- Versiones primero: es el único corte que convierte "empeoró" en
           algo atribuible a un cambio que alguien hizo. -->
      <section class="block">
        <h3>
          Por versión del agente
          <span
            v-if="versionDelta !== null"
            class="delta"
            :class="versionDelta < 0 ? 'delta--down' : 'delta--up'"
          >
            {{ versionDelta > 0 ? '+' : '' }}{{ versionDelta }} pts vs. anterior
          </span>
        </h3>
        <p v-if="versionReading" class="block-note">{{ versionReading }}</p>
        <p v-if="!versionsWorthComparing" class="block-note">
          Todavía no hay dos versiones con {{ COMPARABLE_MIN_RUNS }}+ runs para comparar.
        </p>
        <div class="tablewrap">
          <table class="detail-table">
            <thead>
              <tr>
                <th>Config</th>
                <th class="num">Runs</th>
                <th class="num">Éxito</th>
                <th class="num">Iters/run</th>
                <th class="num">Cache</th>
                <th class="num">Costo/run</th>
                <th>Vigencia</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="v in versions" :key="v.promptHash ?? 'none'">
                <td class="mono">{{ v.promptHash ?? 'sin versión' }}</td>
                <td class="num">{{ v.runs }}</td>
                <td class="num">{{ percent(v.successRate) }}</td>
                <td class="num">{{ perRun(v.iters, v.runs) }}</td>
                <td class="num">{{ percent(v.cacheHitRate) }}</td>
                <td class="num">{{ costPerRun(v.costUsd, v.runs) }}</td>
                <td class="dim">{{ shortDate(v.firstSeen) }} → {{ shortDate(v.lastSeen) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="systemVersions.length > 0" class="block">
        <h3>Por versión de system prompt</h3>
        <p class="block-note">
          Los system prompts son compartidos: una versión nueva acá afecta a todos los agentes que los usan, no sólo a éste.
        </p>
        <div class="tablewrap">
          <table class="detail-table">
            <tbody>
              <tr v-for="v in systemVersions" :key="v.systemPromptHash ?? 'none'">
                <td class="mono">{{ v.systemPromptHash ?? 'sin versión' }}</td>
                <td class="num">{{ v.runs }} runs</td>
                <td class="num">{{ percent(v.successRate) }}</td>
                <td class="num">{{ perRun(v.iters, v.runs) }} iters/run</td>
                <td class="num">{{ costPerRun(v.costUsd, v.runs) }}/run</td>
                <td class="dim">{{ shortDate(v.firstSeen) }} → {{ shortDate(v.lastSeen) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- Tools: 68 llamadas no dicen nada; 50 fs_read es un agente que explora
           a ciegas y 10 errores de bash_run es una policy corta. -->
      <section v-if="tools.length > 0" class="block">
        <h3>Tools</h3>
        <ul class="tool-list">
          <li v-for="t in tools" :key="t.name" class="tool-row">
            <span class="mono tool-row__name">{{ t.name }}</span>
            <span class="tool-row__bar" aria-hidden="true">
              <span class="tool-row__fill" :style="{ width: `${(t.calls / maxToolCalls) * 100}%` }"></span>
            </span>
            <span class="num tool-row__calls">{{ t.calls }}</span>
            <span class="tool-row__errors" :class="{ 'tool-row__errors--some': t.errors > 0 }">
              {{ t.errors > 0 ? `${t.errors} err` : '' }}
            </span>
          </li>
        </ul>
      </section>

      <section v-if="days.length > 0" class="block">
        <h3>Runs por día</h3>
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

      <section v-if="failures.length > 0" class="block">
        <h3>Últimos fallos</h3>
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
  </section>
</template>

<style scoped>
.agent-page { display: flex; flex-direction: column; gap: 1rem; }
.agent-page__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}
.agent-page__title { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.agent-page__title h2 { margin: 0; font-size: 1.15rem; }
.agent-page__editor { font-size: var(--fs-body-sm); color: var(--info); }
.agent-page__error { font-size: var(--fs-body-sm); color: var(--danger); margin: 0; }
.agent-page__empty { font-size: var(--fs-body-sm); color: var(--fg-dim); margin: 0; }

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

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 0.5rem;
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
}
.tile strong { font-size: 1.15rem; font-variant-numeric: tabular-nums; }
.tile__sub { font-size: var(--fs-micro); color: var(--fg-dim); font-variant-numeric: tabular-nums; }
.tile__sub--bad { color: var(--danger); }

.tokens-line { margin: 0; font-size: var(--fs-body-sm); color: var(--fg-mute); line-height: 1.6; }
.model-chip {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0 0.4rem;
  border: 1px solid var(--border-hi);
  border-radius: var(--radius-sm);
  font-size: var(--fs-micro);
  color: var(--info);
}

.block { display: flex; flex-direction: column; gap: 0.4rem; }
.block h3 {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--fg-mute);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.block-note { margin: 0; font-size: var(--fs-chrome); color: var(--fg-dim); }
.delta { font-size: var(--fs-micro); border-radius: var(--radius-sm); padding: 0 0.4rem; font-weight: 600; }
.delta--down { background: var(--danger); color: var(--panel); }
.delta--up { background: var(--accent); color: var(--panel); }

.tablewrap { overflow-x: auto; }
.detail-table { width: 100%; border-collapse: collapse; font-size: var(--fs-body-sm); }
.detail-table th {
  text-align: left;
  font-weight: 600;
  color: var(--fg-dim);
  font-size: var(--fs-micro);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--border);
  padding: 0.2rem 0.4rem;
}
.detail-table td { padding: 0.2rem 0.4rem; border-bottom: 1px solid var(--border); }
.detail-table .num, .detail-table th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.dim { color: var(--fg-dim); }

.tool-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.tool-row {
  display: grid;
  grid-template-columns: minmax(10rem, 1fr) 2fr 3.5rem 4rem;
  align-items: center;
  gap: 0.6rem;
  min-height: var(--row-h);
  font-size: var(--fs-body-sm);
}
.tool-row__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-row__bar { height: 6px; background: var(--panel-hi); border-radius: var(--radius-sm); overflow: hidden; }
.tool-row__fill { display: block; height: 100%; background: var(--accent); }
.tool-row__calls { text-align: right; font-variant-numeric: tabular-nums; }
.tool-row__errors { font-size: var(--fs-micro); color: var(--fg-dimmer); }
.tool-row__errors--some { color: var(--danger); }

.spark { display: flex; align-items: flex-end; gap: 3px; height: 60px; }
.spark-col { display: flex; flex-direction: column; align-items: center; flex: 1; height: 100%; }
.spark-bar {
  width: 100%;
  min-height: 2px;
  background: var(--danger);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  margin-top: auto;
}
.spark-ok { width: 100%; background: var(--accent); }
.spark-label { font-size: var(--fs-micro); color: var(--fg-dim); margin-top: 2px; }

.failure-list { list-style: none; margin: 0; padding: 0; }
.failure-list li { border-bottom: 1px solid var(--border); padding: 0.35rem 0; }
.failure-head { display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap; }
.failure-title { font-size: var(--fs-body-sm); flex: 1; min-width: 0; }
.failure-time { font-size: var(--fs-micro); color: var(--fg-dim); }
.failure-msg {
  margin: 0.2rem 0 0;
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  font-family: var(--font-mono);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.class-chip {
  border: 1px solid var(--border-hi);
  background: transparent;
  color: var(--fg-dim);
  border-radius: var(--radius-sm);
  padding: 0 0.45rem;
  font-size: var(--fs-micro);
  cursor: pointer;
}
.class-chip:hover { border-color: var(--accent); color: var(--accent); }
.class-chip--muted { cursor: default; }
</style>
