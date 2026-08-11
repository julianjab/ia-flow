<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { fetchAvailableAgents } from '@/features/projects/availableApi';
import { useProjectsStore } from '@/features/projects/store';
import { fetchServerLogs, type ServerLogEntry } from '@/features/server-logs/api';
import type { AgentDefinition, ServerLogLevel } from '@ia-flow/shared';
import { type ExecutionLog, fetchExecutions } from './api';

// The outcome enum lives in shared/schemas.ts. We enumerate the labels here
// because the select needs a stable order + a Spanish label — mirroring the
// tone of TareasSection.vue (no i18n framework yet).
type OutcomeFilter = '' | 'success' | 'error' | 'cancelled' | 'truncated';
const OUTCOME_OPTIONS: { value: OutcomeFilter; label: string }[] = [
  { value: '',          label: 'Todos'      },
  { value: 'success',   label: 'Success'    },
  { value: 'error',     label: 'Error'      },
  { value: 'cancelled', label: 'Cancelled'  },
  { value: 'truncated', label: 'Truncated'  },
];

const DEFAULT_LIMIT = 100;
const LIMIT_STEP = 100;

// How many server-log entries to pull for the related-logs sub-panel. The
// route caps at 1000 and each execution rarely emits more than a few hundred
// tool.call / tool.result / api.* lines, so 500 is comfortably enough.
const RELATED_LOGS_LIMIT = 500;
// When the execution is still open (finishedAt = null), bound the "to"
// window at now + this margin so we still catch late-arriving log lines
// from an in-flight run.
const OPEN_RUN_TO_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

const projectsStore = useProjectsStore();
const activeProjectId = computed(() => projectsStore.activeProjectId);
const activeProject = computed(() => projectsStore.activeProject);

// Server-side filters — the watchers below refetch when any of these change.
const agentFilter = ref('');
const outcomeFilter = ref<OutcomeFilter>('');
const fromFilter = ref('');
const toFilter = ref('');
const limit = ref(DEFAULT_LIMIT);

// Client-side filter: filters the already-loaded page by title/taskId.
// Debounced to avoid re-running the computed on every keystroke; we hold the
// applied value in a separate ref so the input stays snappy.
const taskTextInput = ref('');
const taskTextApplied = ref('');
let taskTextDebounce: ReturnType<typeof setTimeout> | null = null;
watch(taskTextInput, (v) => {
  if (taskTextDebounce) clearTimeout(taskTextDebounce);
  taskTextDebounce = setTimeout(() => {
    taskTextApplied.value = v.trim().toLowerCase();
  }, 300);
});

const executions = ref<ExecutionLog[]>([]);
const agents = ref<AgentDefinition[]>([]);
const loading = ref(false);
const error = ref<string>('');
const expandedId = ref<string | null>(null);

// Per-execution cache for the related-logs sub-panel. Keyed by exec.id so
// re-expanding a card doesn't refetch (unless the user hits "↻ recargar").
const relatedLogs = ref<Record<string, ServerLogEntry[]>>({});
const relatedLoading = ref<Record<string, boolean>>({});
const relatedError = ref<Record<string, string>>({});

// Try to derive a GitHub issue URL from the project source + taskId. The
// execution log doesn't carry issueNumber directly, so we only render the link
// when the project is github-backed AND taskId is a plain integer (that's the
// shape github source items use). Anything else falls back to plain text.
const githubBaseUrl = computed<string | null>(() => {
  const src = activeProject.value?.source;
  if (!src || src.kind !== 'github') return null;
  const url = src.config?.url;
  return typeof url === 'string' && url ? url.replace(/\/+$/, '') : null;
});

function issueUrlFor(taskId: string): string | null {
  if (!githubBaseUrl.value) return null;
  const m = taskId.match(/^\#?(\d+)$/) ?? taskId.match(/(\d+)\s*$/);
  if (!m) return null;
  return `${githubBaseUrl.value}/issues/${m[1]}`;
}

const filteredExecutions = computed<ExecutionLog[]>(() => {
  const q = taskTextApplied.value;
  if (!q) return executions.value;
  return executions.value.filter((e) =>
    e.taskTitle.toLowerCase().includes(q) || e.taskId.toLowerCase().includes(q),
  );
});

// Client-side column sort over filteredExecutions. Server already returns
// most-recent-first; we let the user re-sort in-place without a refetch.
type ExecSortColumn = 'startedAt' | 'taskTitle' | 'agentId' | 'providerId' | 'duration' | 'outcome';
const execSort = ref<{ column: ExecSortColumn; direction: 'asc' | 'desc' }>({
  column: 'startedAt',
  direction: 'desc',
});
function selectExecColumn(column: ExecSortColumn) {
  if (execSort.value.column === column) {
    execSort.value = {
      column,
      direction: execSort.value.direction === 'asc' ? 'desc' : 'asc',
    };
  } else {
    execSort.value = { column, direction: 'desc' };
  }
}
function execSortArrow(column: ExecSortColumn): string {
  if (execSort.value.column !== column) return '';
  return execSort.value.direction === 'asc' ? ' ▲' : ' ▼';
}
function durationMs(exec: ExecutionLog): number {
  if (!exec.finishedAt) return Number.POSITIVE_INFINITY;
  return new Date(exec.finishedAt).getTime() - new Date(exec.startedAt).getTime();
}
const OUTCOME_RANK: Record<string, number> = {
  success: 0, truncated: 1, cancelled: 2, error: 3, pending: 4,
};
const sortedExecutions = computed<ExecutionLog[]>(() => {
  const arr = [...filteredExecutions.value];
  const { column, direction } = execSort.value;
  const dir = direction === 'asc' ? 1 : -1;
  arr.sort((a, b) => {
    let cmp = 0;
    switch (column) {
      case 'startedAt': cmp = a.startedAt.localeCompare(b.startedAt); break;
      case 'taskTitle': cmp = a.taskTitle.localeCompare(b.taskTitle); break;
      case 'agentId':   cmp = a.agentId.localeCompare(b.agentId); break;
      case 'providerId': cmp = a.providerId.localeCompare(b.providerId); break;
      case 'duration':  cmp = durationMs(a) - durationMs(b); break;
      case 'outcome': {
        const oa = OUTCOME_RANK[a.outcome ?? 'pending'] ?? 99;
        const ob = OUTCOME_RANK[b.outcome ?? 'pending'] ?? 99;
        cmp = oa - ob;
        break;
      }
    }
    return cmp * dir;
  });
  return arr;
});

// Outcome counts across the loaded page — powers the summary chip row.
const OUTCOME_ORDER: Array<'success' | 'error' | 'cancelled' | 'truncated' | 'pending'> = [
  'success', 'error', 'cancelled', 'truncated', 'pending',
];
const outcomeCounts = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = { success: 0, error: 0, cancelled: 0, truncated: 0, pending: 0 };
  for (const e of executions.value) counts[e.outcome ?? 'pending']++;
  return counts;
});
function selectSummaryOutcome(oc: 'success' | 'error' | 'cancelled' | 'truncated' | 'pending') {
  // 'pending' isn't a server-side filter; treat clicks on it as a no-op.
  if (oc === 'pending') return;
  outcomeFilter.value = outcomeFilter.value === oc ? '' : oc;
}

// Compact date column matching the Logs table: HH:MM:SS today, "DD MMM HH:MM"
// for older entries. Full ISO available on hover.
const EXEC_MONTH_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function formatDateCompact(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return sameDay ? hms : `${pad(d.getDate())} ${EXEC_MONTH_ABBR[d.getMonth()]} ${hms}`;
}

async function loadAgents() {
  const pid = activeProjectId.value;
  if (!pid) { agents.value = []; return; }
  try {
    agents.value = await fetchAvailableAgents(pid);
  } catch {
    // Non-fatal: the agent select just falls back to "Todos" without options.
    agents.value = [];
  }
}

async function load() {
  const pid = activeProjectId.value;
  if (!pid) {
    executions.value = [];
    error.value = 'Selecciona un proyecto primero.';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    executions.value = await fetchExecutions({
      projectId: pid,
      ...(agentFilter.value ? { agentId: agentFilter.value } : {}),
      ...(outcomeFilter.value ? { outcome: outcomeFilter.value } : {}),
      ...(fromFilter.value ? { from: fromFilter.value } : {}),
      ...(toFilter.value ? { to: toFilter.value } : {}),
      limit: limit.value,
    });
  } catch (e) {
    // Axios throws Error subclasses with a descriptive `.message`; surface
    // that in the banner instead of console.error (see CLAUDE.md).
    error.value = e instanceof Error ? e.message : String(e);
    executions.value = [];
  } finally {
    loading.value = false;
  }
}

// ─── Related logs (tool calls + agent events) ─────────────────────────────
// The server-logs endpoint doesn't index by taskId, so we bound the query by
// the execution's time window and let the server return every log in that
// range, then filter client-side to entries whose `extras.taskId` matches.
// This is cheap enough for a per-expand fetch and avoids growing the API
// surface for a UI-only concern.
function runToIso(exec: ExecutionLog): string {
  if (exec.finishedAt) return exec.finishedAt;
  return new Date(Date.now() + OPEN_RUN_TO_MARGIN_MS).toISOString();
}

async function loadRelatedLogs(exec: ExecutionLog) {
  relatedLoading.value = { ...relatedLoading.value, [exec.id]: true };
  relatedError.value = { ...relatedError.value, [exec.id]: '' };
  try {
    const { entries } = await fetchServerLogs({
      from: exec.startedAt,
      to: runToIso(exec),
      limit: RELATED_LOGS_LIMIT,
      offset: 0,
      sort: 'asc',
    });
    // Newer runs stamp every log line with `runId === exec.id`. Fall back to
    // taskId for pre-migration executions where the correlation id didn't
    // exist yet.
    const forThisRun = entries.filter((e) => {
      const extras = e.extras;
      if (!extras) return false;
      if (extras.runId === exec.id) return true;
      if (!extras.runId && extras.taskId === exec.taskId) return true;
      return false;
    });
    relatedLogs.value = { ...relatedLogs.value, [exec.id]: forThisRun };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    relatedError.value = { ...relatedError.value, [exec.id]: msg };
  } finally {
    relatedLoading.value = { ...relatedLoading.value, [exec.id]: false };
  }
}

function reloadRelatedLogs(exec: ExecutionLog) {
  // Explicit refresh — clear the cache entry so `loadRelatedLogs` refetches
  // even if this exec has already been expanded once.
  const next = { ...relatedLogs.value };
  delete next[exec.id];
  relatedLogs.value = next;
  void loadRelatedLogs(exec);
}

// Per-event expansion inside the related-logs list. Key format is
// `${exec.id}-${index}` so the same event across two open execs stays
// independent. Null = collapsed.
const expandedEventKey = ref<string | null>(null);
function toggleEvent(key: string) {
  expandedEventKey.value = expandedEventKey.value === key ? null : key;
}
function copyEventJson(entry: ServerLogEntry) {
  void navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
}

function toolFromExtras(entry: ServerLogEntry): string | null {
  const t = entry.extras?.tool;
  return typeof t === 'string' ? t : null;
}

function eventFromExtras(entry: ServerLogEntry): string | null {
  const ev = entry.extras?.event;
  return typeof ev === 'string' ? ev : null;
}

function isToolEvent(entry: ServerLogEntry): boolean {
  const ev = eventFromExtras(entry);
  return ev === 'tool.call' || ev === 'tool.result';
}

// ─── Row expansion ────────────────────────────────────────────────────────
function toggleRow(id: string) {
  const opening = expandedId.value !== id;
  expandedId.value = opening ? id : null;
  if (opening) {
    const exec = executions.value.find((e) => e.id === id);
    // Only fetch on the *first* expand — cached entries survive subsequent
    // collapses. reloadRelatedLogs() gives the user an explicit refresh.
    if (exec && !(exec.id in relatedLogs.value)) {
      void loadRelatedLogs(exec);
    }
  }
}

function loadMore() {
  limit.value += LIMIT_STEP;
  // limit is a server-side filter; the watcher below will fire load().
}

// Copy the full ExecutionLog JSON to the clipboard. `navigator.clipboard`
// needs a secure context (HTTPS or localhost), which matches our dev setup.
function copyJson(exec: ExecutionLog) {
  void navigator.clipboard.writeText(JSON.stringify(exec, null, 2));
}

// Formatters — kept as plain functions so the template stays declarative.
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es-CO');
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('es-CO', { hour12: false });
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return '—';
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return '—';
  const ms = end - start;
  if (ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remSec}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m`;
}

function outcomeColor(outcome: ExecutionLog['outcome']): { bg: string; fg: string } {
  switch (outcome) {
    case 'success':   return { bg: '#16a34a', fg: '#ffffff' };
    case 'error':     return { bg: '#dc2626', fg: '#ffffff' };
    case 'cancelled': return { bg: '#6b7280', fg: '#ffffff' };
    case 'truncated': return { bg: '#ea580c', fg: '#ffffff' };
    default:          return { bg: '#e5e7eb', fg: '#374151' };
  }
}

function outcomeLabel(outcome: ExecutionLog['outcome']): string {
  return outcome ?? 'pending';
}

// Same palette used by ServerLogsSection — kept in sync so a log's level
// looks identical whether it's rendered in the Logs tab or the exec detail.
function levelColor(level: ServerLogLevel): { bg: string; fg: string } {
  switch (level) {
    case 'trace': return { bg: '#9ca3af', fg: '#ffffff' };
    case 'debug': return { bg: '#93c5fd', fg: '#1e40af' };
    case 'info':  return { bg: '#16a34a', fg: '#ffffff' };
    case 'warn':  return { bg: '#ca8a04', fg: '#ffffff' };
    case 'error': return { bg: '#dc2626', fg: '#ffffff' };
    case 'fatal': return { bg: '#7f1d1d', fg: '#ffffff' };
  }
}

const REL_MSG_TRUNCATE = 140;
function truncateMsg(msg: string): string {
  return msg.length > REL_MSG_TRUNCATE ? `${msg.slice(0, REL_MSG_TRUNCATE)}…` : msg;
}

onMounted(() => {
  void loadAgents();
  void load();
});

// Reload when the active project changes — same pattern as StatusesSection.
watch(activeProjectId, () => {
  // Reset filters that don't make sense across projects.
  agentFilter.value = '';
  expandedId.value = null;
  limit.value = DEFAULT_LIMIT;
  relatedLogs.value = {};
  relatedLoading.value = {};
  relatedError.value = {};
  void loadAgents();
  void load();
});

// Server-side filters: refetch on change. `immediate: false` (the default)
// keeps the initial load in onMounted from double-firing.
watch(
  [agentFilter, outcomeFilter, fromFilter, toFilter, limit],
  () => { void load(); },
);
</script>

<template>
  <section class="settings-section">
    <div class="section-header">
      <div>
        <h2>Ejecuciones</h2>
        <p class="section-desc">
          Historial de agentes ejecutados sobre las tareas de este proyecto.
          Los filtros de agente, outcome y fechas se aplican en el servidor.
        </p>
      </div>
      <button
        type="button"
        class="btn-primary"
        :disabled="loading"
        @click="load()"
      >
        {{ loading ? 'Cargando…' : '↺ Actualizar' }}
      </button>
    </div>

    <div class="filters">
      <label class="filter">
        <span>Agente</span>
        <select v-model="agentFilter">
          <option value="">Todos</option>
          <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.id }}</option>
        </select>
      </label>

      <label class="filter">
        <span>Outcome</span>
        <select v-model="outcomeFilter">
          <option v-for="o in OUTCOME_OPTIONS" :key="o.value" :value="o.value">
            {{ o.label }}
          </option>
        </select>
      </label>

      <label class="filter">
        <span>Desde</span>
        <input type="date" v-model="fromFilter" />
      </label>

      <label class="filter">
        <span>Hasta</span>
        <input type="date" v-model="toFilter" />
      </label>

      <label class="filter filter--grow">
        <span>Tarea</span>
        <input
          type="text"
          v-model="taskTextInput"
          placeholder="Filtrar por título o taskId…"
        />
      </label>
    </div>

    <div v-if="error" class="items-error">{{ error }}</div>

    <div class="exec-summary" aria-label="Resumen por outcome">
      <span class="exec-summary__total">{{ executions.length }} ejecuciones</span>
      <button
        v-for="oc in OUTCOME_ORDER"
        :key="oc"
        type="button"
        class="exec-summary__chip"
        :class="[
          `exec-summary__chip--${oc}`,
          { 'exec-summary__chip--zero': outcomeCounts[oc] === 0 },
        ]"
        :aria-pressed="outcomeFilter === oc"
        :data-testid="`executions-summary-${oc}`"
        @click="selectSummaryOutcome(oc)"
      >
        {{ oc }} <b>{{ outcomeCounts[oc] }}</b>
      </button>
    </div>

    <div class="exec-list-wrapper">
      <div class="exec-list-header" role="row">
        <button
          type="button"
          class="exec-title exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'taskTitle' }"
          @click="selectExecColumn('taskTitle')"
        >Título{{ execSortArrow('taskTitle') }}</button>
        <button
          type="button"
          class="exec-meta exec-agent exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'agentId' }"
          @click="selectExecColumn('agentId')"
        >Agente{{ execSortArrow('agentId') }}</button>
        <button
          type="button"
          class="exec-meta exec-provider exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'providerId' }"
          @click="selectExecColumn('providerId')"
        >Provider{{ execSortArrow('providerId') }}</button>
        <button
          type="button"
          class="exec-meta exec-date exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'startedAt' }"
          @click="selectExecColumn('startedAt')"
        >Fecha{{ execSortArrow('startedAt') }}</button>
        <button
          type="button"
          class="exec-meta exec-duration exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'duration' }"
          @click="selectExecColumn('duration')"
        >Duración{{ execSortArrow('duration') }}</button>
        <button
          type="button"
          class="exec-outcome-col exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'outcome' }"
          @click="selectExecColumn('outcome')"
        >Outcome{{ execSortArrow('outcome') }}</button>
        <span class="exec-chevron"></span>
      </div>

      <p v-if="loading && !executions.length" class="exec-empty">Cargando ejecuciones…</p>
      <p v-else-if="!filteredExecutions.length" class="exec-empty">
        No hay ejecuciones para los filtros actuales.
      </p>

      <ul v-else class="exec-list">
        <li
          v-for="exec in sortedExecutions"
          :key="exec.id"
          class="exec-card"
          :class="{ 'exec-card--open': expandedId === exec.id }"
        >
          <button
            type="button"
            class="exec-row"
            @click="toggleRow(exec.id)"
            :aria-expanded="expandedId === exec.id"
          >
            <span class="exec-title">
              <a
                v-if="issueUrlFor(exec.taskId)"
                :href="issueUrlFor(exec.taskId)!"
                target="_blank"
                rel="noopener noreferrer"
                @click.stop
              >{{ exec.taskTitle }} ↗</a>
              <template v-else>{{ exec.taskTitle }}</template>
            </span>
            <span class="exec-meta exec-agent">{{ exec.agentId }}</span>
            <span class="exec-meta exec-provider">{{ exec.providerId }}</span>
            <span class="exec-meta exec-date" :title="exec.startedAt">{{ formatDateCompact(exec.startedAt) }}</span>
            <span class="exec-meta exec-duration">{{ formatDuration(exec.startedAt, exec.finishedAt) }}</span>
            <span
              class="exec-outcome"
              :style="{
                background: outcomeColor(exec.outcome).bg,
                color: outcomeColor(exec.outcome).fg,
              }"
            >{{ outcomeLabel(exec.outcome) }}</span>
            <span class="exec-chevron" aria-hidden="true">
              {{ expandedId === exec.id ? '▾' : '▸' }}
            </span>
          </button>

        <div v-if="expandedId === exec.id" class="exec-detail">
          <div class="detail-row">
            <span class="detail-label">taskId</span>
            <code class="detail-value">{{ exec.taskId }}</code>
          </div>
          <div class="detail-row">
            <span class="detail-label">agentId</span>
            <code class="detail-value">{{ exec.agentId }}</code>
          </div>
          <div class="detail-row">
            <span class="detail-label">providerId</span>
            <code class="detail-value">{{ exec.providerId }}</code>
          </div>
          <div v-if="exec.errorMsg" class="detail-row">
            <span class="detail-label">errorMsg</span>
            <pre class="detail-value detail-value--pre">{{ exec.errorMsg }}</pre>
          </div>
          <div v-if="exec.stopReason" class="detail-row">
            <span class="detail-label">stopReason</span>
            <code class="detail-value">{{ exec.stopReason }}</code>
          </div>
          <div class="detail-row">
            <span class="detail-label">startedAt</span>
            <code class="detail-value">{{ exec.startedAt }}</code>
          </div>
          <div class="detail-row">
            <span class="detail-label">finishedAt</span>
            <code class="detail-value">{{ exec.finishedAt ?? '—' }}</code>
          </div>

          <div class="related-block">
            <div class="related-header">
              <span class="detail-label">
                Tool calls y eventos del servidor
                <span
                  v-if="relatedLogs[exec.id]"
                  class="related-count"
                >({{ relatedLogs[exec.id].length }})</span>
              </span>
              <div class="related-actions">
                <button
                  type="button"
                  class="btn-copy"
                  data-testid="executions-related-refresh"
                  :disabled="relatedLoading[exec.id]"
                  @click="reloadRelatedLogs(exec)"
                >
                  ↻ Recargar
                </button>
              </div>
            </div>

            <div v-if="relatedLoading[exec.id]" class="related-empty">
              Cargando logs relacionados…
            </div>
            <div v-else-if="relatedError[exec.id]" class="items-error related-error">
              {{ relatedError[exec.id] }}
            </div>
            <div
              v-else-if="relatedLogs[exec.id] && relatedLogs[exec.id].length === 0"
              class="related-empty"
            >
              No se encontraron entradas en <code>daemon.log</code> para esta ejecución
              (ventana: <code>{{ exec.startedAt }}</code> → <code>{{ exec.finishedAt ?? 'en curso' }}</code>).
              Los agentes async (tmux/iterm) no emiten <code>tool.call</code>/<code>tool.result</code>
              — sus tool calls quedan registrados por Claude Code, no por el daemon.
            </div>
            <ul
              v-else-if="relatedLogs[exec.id]"
              class="related-list"
              data-testid="executions-related-list"
            >
              <li
                v-for="(entry, i) in relatedLogs[exec.id]"
                :key="`${exec.id}-${entry.time}-${i}`"
                class="related-card"
                :class="{
                  'related-card--tool': isToolEvent(entry),
                  'related-card--open': expandedEventKey === `${exec.id}-${i}`,
                }"
              >
                <button
                  type="button"
                  class="related-row"
                  :aria-expanded="expandedEventKey === `${exec.id}-${i}`"
                  @click="toggleEvent(`${exec.id}-${i}`)"
                >
                  <span class="related-time">{{ formatTime(entry.time) }}</span>
                  <span
                    class="related-level"
                    :style="{
                      background: levelColor(entry.level).bg,
                      color: levelColor(entry.level).fg,
                    }"
                  >{{ entry.level }}</span>
                  <span v-if="toolFromExtras(entry)" class="related-tool">
                    <span class="related-tool-tag">{{ eventFromExtras(entry) || 'tool' }}</span>
                    <code class="related-tool-name">{{ toolFromExtras(entry) }}</code>
                  </span>
                  <span v-else-if="eventFromExtras(entry)" class="related-event">
                    {{ eventFromExtras(entry) }}
                  </span>
                  <span class="related-msg">{{ truncateMsg(entry.msg) }}</span>
                  <span class="related-chevron" aria-hidden="true">
                    {{ expandedEventKey === `${exec.id}-${i}` ? '▾' : '▸' }}
                  </span>
                </button>

                <div v-if="expandedEventKey === `${exec.id}-${i}`" class="related-detail">
                  <div class="related-detail-header">
                    <span class="detail-label">JSON completo del evento</span>
                    <button
                      type="button"
                      class="btn-copy"
                      data-testid="executions-related-copy-json"
                      @click="copyEventJson(entry)"
                    >
                      Copiar JSON
                    </button>
                  </div>
                  <pre class="related-detail-json">{{ JSON.stringify(entry, null, 2) }}</pre>
                </div>
              </li>
            </ul>
          </div>

          <div class="detail-json-block">
            <div class="detail-json-header">
              <span class="detail-label">JSON completo</span>
              <button
                type="button"
                class="btn-copy"
                data-testid="executions-copy-json"
                @click="copyJson(exec)"
              >
                Copiar JSON
              </button>
            </div>
            <pre class="detail-json">{{ JSON.stringify(exec, null, 2) }}</pre>
          </div>
        </div>
        </li>
      </ul>
    </div>

    <div v-if="executions.length === limit" class="load-more">
      <button type="button" class="btn-secondary" :disabled="loading" @click="loadMore()">
        Cargar más
      </button>
    </div>
  </section>
</template>

<style scoped>
.settings-section { border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem; }
.settings-section h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.section-desc { margin: 0 0 0.9rem; font-size: 0.82rem; color: #6b7280; line-height: 1.5; }
.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.75rem; }
.section-header h2 { margin: 0 0 0.2rem; font-size: 1.05rem; }

.btn-primary {
  flex-shrink: 0;
  padding: 0.35rem 0.8rem;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.btn-primary:hover { background: #1d4ed8; }
.btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

.btn-secondary {
  padding: 0.4rem 0.85rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  font-size: 0.85rem;
  color: #374151;
  cursor: pointer;
}
.btn-secondary:hover { background: #f3f4f6; }
.btn-secondary:disabled { opacity: 0.6; cursor: not-allowed; }

.btn-copy {
  padding: 0.25rem 0.65rem;
  border: 1px solid #d1d5db;
  border-radius: 5px;
  background: #fff;
  font-size: 0.75rem;
  color: #374151;
  cursor: pointer;
}
.btn-copy:hover { background: #f3f4f6; }
.btn-copy:disabled { opacity: 0.6; cursor: not-allowed; }

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  padding: 0.65rem 0.75rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  margin-bottom: 0.85rem;
}
.filter { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.78rem; color: #374151; min-width: 130px; }
.filter--grow { flex: 1; min-width: 200px; }
.filter span { font-weight: 500; color: #6b7280; }
.filter select, .filter input {
  padding: 0.3rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 5px;
  font-size: 0.85rem;
  background: #fff;
  color: #111827;
}

.empty { font-size: 0.875rem; color: #9ca3af; padding: 0.5rem 0; }
.items-error {
  padding: 0.6rem 0.85rem;
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 6px;
  font-size: 0.82rem;
  color: #dc2626;
  margin-bottom: 0.75rem;
}

/* ─── Summary row (outcome counts) ─────────────────────────────────── */
.exec-summary {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.6rem;
  margin-bottom: 0.5rem;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-size: 0.75rem;
  flex-wrap: wrap;
}
.exec-summary__total { color: #6b7280; margin-right: 0.4rem; }
.exec-summary__chip {
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  border: 1px solid transparent;
  cursor: pointer;
  font-size: 0.72rem;
  text-transform: lowercase;
  line-height: 1.2;
  transition: transform 0.08s ease;
}
.exec-summary__chip b { margin-left: 0.25rem; font-weight: 700; }
.exec-summary__chip:hover { transform: translateY(-1px); }
.exec-summary__chip[aria-pressed='true'] { outline: 2px solid #111827; outline-offset: 1px; }
.exec-summary__chip--success   { background: #dcfce7; color: #14532d; }
.exec-summary__chip--error     { background: #fee2e2; color: #7f1d1d; }
.exec-summary__chip--cancelled { background: #f3f4f6; color: #4b5563; }
.exec-summary__chip--truncated { background: #ffedd5; color: #7c2d12; }
.exec-summary__chip--pending   { background: #e5e7eb; color: #374151; cursor: default; }
.exec-summary__chip--zero { opacity: 0.4; }
.exec-summary__chip--zero:hover { opacity: 0.7; }

/* ─── Table wrapper + sticky sortable header ───────────────────────── */
.exec-list-wrapper { position: relative; }
.exec-list-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 0.85rem;
  background: #f3f4f6;
  border: 1px solid #e5e7eb;
  border-radius: 6px 6px 0 0;
  font-size: 0.7rem;
  font-weight: 600;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  position: sticky;
  top: 0;
  z-index: 1;
}
.exec-header-btn {
  background: none;
  border: none;
  padding: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.exec-header-btn:hover { color: #111827; }
.exec-header-btn--active { color: #111827; }
.exec-list-header .exec-outcome-col {
  flex-shrink: 0;
  min-width: 72px;
  text-align: center;
}
.exec-empty {
  padding: 1.5rem 0.75rem;
  text-align: center;
  color: #9ca3af;
  font-size: 0.85rem;
  border: 1px solid #e5e7eb;
  border-top: none;
  border-radius: 0 0 6px 6px;
  margin: 0;
}

.exec-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.exec-card {
  border: 1px solid #e5e7eb;
  border-top: none;
  background: #fff;
  overflow: hidden;
}
.exec-card:last-child { border-radius: 0 0 6px 6px; }
.exec-card--open { border-color: #93c5fd; background: #eff6ff; }

.exec-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.6rem 0.85rem;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: 0.85rem;
  color: #111827;
}
.exec-row:hover { background: #f9fafb; }
.exec-title { flex: 1; min-width: 0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.exec-title a { color: #2563eb; text-decoration: none; }
.exec-title a:hover { text-decoration: underline; }
.exec-meta { font-size: 0.75rem; color: #6b7280; flex-shrink: 0; }
.exec-agent { font-family: 'SF Mono', 'Fira Code', monospace; color: #4f46e5; }
.exec-provider { font-family: 'SF Mono', 'Fira Code', monospace; }
.exec-date { font-variant-numeric: tabular-nums; }
.exec-duration { font-variant-numeric: tabular-nums; min-width: 55px; text-align: right; }
.exec-outcome {
  flex-shrink: 0;
  font-size: 0.7rem;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 600;
  text-transform: lowercase;
  min-width: 72px;
  text-align: center;
}
.exec-chevron { color: #9ca3af; font-size: 0.85rem; }

.exec-detail {
  padding: 0.75rem 0.85rem;
  border-top: 1px solid #e5e7eb;
  background: #f9fafb;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.detail-row { display: flex; gap: 0.6rem; align-items: flex-start; font-size: 0.8rem; }
.detail-label { min-width: 90px; color: #6b7280; font-weight: 500; }
.detail-value { color: #111827; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.78rem; word-break: break-all; }
.detail-value--pre { white-space: pre-wrap; margin: 0; background: #fff; border: 1px solid #e5e7eb; padding: 0.4rem 0.55rem; border-radius: 4px; flex: 1; }

.related-block {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: 0.5rem;
  padding: 0.55rem 0.65rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
}
.related-header { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.related-actions { display: flex; gap: 0.35rem; flex-wrap: wrap; }
.related-count { color: #6b7280; font-weight: 400; margin-left: 0.25rem; font-size: 0.72rem; }
.related-empty { font-size: 0.78rem; color: #6b7280; padding: 0.35rem 0; line-height: 1.5; }
.related-empty code {
  background: #f3f4f6;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  font-size: 0.72rem;
}
.related-error { margin: 0; }
.related-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  max-height: 340px;
  overflow: auto;
  border-top: 1px solid #f3f4f6;
  padding-top: 0.35rem;
}
.related-card {
  border-radius: 4px;
  overflow: hidden;
}
.related-card--tool { background: #fef9c3; }
.related-card--open { background: #eef2ff; }
.related-row {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  padding: 0.25rem 0.3rem;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
  font-size: 0.76rem;
  color: #111827;
}
.related-row:hover { background: rgba(0,0,0,0.03); }
.related-chevron { color: #9ca3af; font-size: 0.8rem; margin-left: auto; }
.related-detail {
  padding: 0.5rem 0.6rem 0.6rem;
  border-top: 1px solid #e5e7eb;
  background: #ffffff;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.related-detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.related-detail-json {
  margin: 0;
  padding: 0.5rem 0.6rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.72rem;
  color: #111827;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 380px;
  overflow: auto;
}
.related-time {
  flex-shrink: 0;
  min-width: 78px;
  font-variant-numeric: tabular-nums;
  color: #6b7280;
  font-size: 0.72rem;
}
.related-level {
  flex-shrink: 0;
  font-size: 0.65rem;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  font-weight: 600;
  text-transform: lowercase;
  min-width: 46px;
  text-align: center;
}
.related-tool {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 200px;
}
.related-tool-tag {
  font-size: 0.65rem;
  padding: 0.05rem 0.4rem;
  border-radius: 3px;
  background: #4f46e5;
  color: #ffffff;
  text-transform: lowercase;
  font-weight: 600;
}
.related-tool-name {
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: #4f46e5;
  font-size: 0.72rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
}
.related-event {
  flex-shrink: 0;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: #6b7280;
  font-size: 0.7rem;
  min-width: 130px;
}
.related-msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #374151;
}

.detail-json-block { display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.35rem; }
.detail-json-header { display: flex; justify-content: space-between; align-items: center; }
.detail-json {
  margin: 0;
  padding: 0.55rem 0.7rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  color: #111827;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 400px;
  overflow: auto;
}

.load-more { display: flex; justify-content: center; margin-top: 0.85rem; }
</style>
