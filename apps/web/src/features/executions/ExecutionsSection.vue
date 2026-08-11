<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { fetchAvailableAgents } from '@/features/projects/availableApi';
import { useProjectsStore } from '@/features/projects/store';
import type { AgentDefinition } from '@ia-flow/shared';
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

function toggleRow(id: string) {
  expandedId.value = expandedId.value === id ? null : id;
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

    <div v-else-if="loading && !executions.length" class="empty">
      Cargando ejecuciones…
    </div>

    <div v-else-if="!filteredExecutions.length" class="empty">
      No hay ejecuciones para los filtros actuales.
    </div>

    <ul v-else class="exec-list">
      <li
        v-for="exec in filteredExecutions"
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
          <span class="exec-meta exec-date">{{ formatDate(exec.startedAt) }}</span>
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

.exec-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.exec-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
}
.exec-card--open { border-color: #93c5fd; }

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
