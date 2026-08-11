<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import type { ServerLogLevel } from '@ia-flow/shared';
import { fetchServerLogs, type ServerLogEntry, type ServerLogFilters } from './api';

// Server-log levels available in the Zod enum. Empty string = "todos" (no
// filter). Order matches severity so it reads top-down in the dropdown.
type LevelFilter = '' | ServerLogLevel;
const LEVEL_OPTIONS: { value: LevelFilter; label: string }[] = [
  { value: '',      label: 'Todos'  },
  { value: 'trace', label: 'trace'  },
  { value: 'debug', label: 'debug'  },
  { value: 'info',  label: 'info'   },
  { value: 'warn',  label: 'warn'   },
  { value: 'error', label: 'error'  },
  { value: 'fatal', label: 'fatal'  },
];

// Page size chosen to keep the /api/server-logs response small while still
// filling a typical screen. The route hard-caps at 1000.
const PAGE_LIMIT = 50;

const levelFilter = ref<LevelFilter>('');
const moduleFilter = ref('');
const fromFilter = ref('');
const toFilter = ref('');

// Debounced text search — `searchApplied` is what actually gets sent to the
// server so we don't refetch on every keystroke.
const searchInput = ref('');
const searchApplied = ref('');
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
watch(searchInput, (v) => {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchApplied.value = v.trim();
  }, 300);
});

const entries = ref<ServerLogEntry[]>([]);
const total = ref(0);
const offset = ref(0);
const loading = ref(false);
const error = ref<string>('');
// Server logs have no stable id, so we key by "time-index" using the position
// within the current accumulated list. It's stable across the render cycle
// because we only append (never re-order) results.
const expandedId = ref<string | null>(null);

function buildFilters(): ServerLogFilters {
  const f: ServerLogFilters = { limit: PAGE_LIMIT, offset: offset.value };
  if (levelFilter.value) f.level = levelFilter.value;
  if (moduleFilter.value.trim()) f.module = moduleFilter.value.trim();
  if (searchApplied.value) f.search = searchApplied.value;
  if (fromFilter.value) f.from = new Date(fromFilter.value).toISOString();
  if (toFilter.value) f.to = new Date(toFilter.value).toISOString();
  return f;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await fetchServerLogs(buildFilters());
    // Append (accumulate) so "Cargar más" grows the list. resetAndLoad()
    // clears entries + offset first when filters change.
    entries.value = entries.value.concat(data.entries);
    total.value = data.total;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Error cargando logs';
  } finally {
    loading.value = false;
  }
}

function resetAndLoad() {
  entries.value = [];
  total.value = 0;
  offset.value = 0;
  expandedId.value = null;
  void load();
}

function loadMore() {
  offset.value += PAGE_LIMIT;
  void load();
}

function clearFilters() {
  levelFilter.value = '';
  moduleFilter.value = '';
  searchInput.value = '';
  searchApplied.value = '';
  fromFilter.value = '';
  toFilter.value = '';
  // Watchers below will trigger resetAndLoad(); do it directly too so the
  // reset happens even when nothing changed (e.g. all filters already empty).
  resetAndLoad();
}

function entryKey(entry: ServerLogEntry, index: number): string {
  return `${entry.time}-${index}`;
}

function toggleRow(id: string) {
  expandedId.value = expandedId.value === id ? null : id;
}

function copyJson(entry: ServerLogEntry) {
  void navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es-CO');
}

const MSG_TRUNCATE = 120;
function truncateMsg(msg: string): string {
  return msg.length > MSG_TRUNCATE ? `${msg.slice(0, MSG_TRUNCATE)}…` : msg;
}

// Fixed palette per PRD — chosen so "warn" reads amber against white and
// "fatal" stays distinguishable from "error".
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

// Refetch from scratch whenever a *server-side* filter changes. `searchInput`
// is intentionally not in this list — we watch `searchApplied` instead so the
// debounce is honoured.
watch([levelFilter, moduleFilter, searchApplied, fromFilter, toFilter], () => {
  resetAndLoad();
});

onMounted(() => {
  void load();
});
</script>

<template>
  <section class="settings-section">
    <div class="section-header">
      <div>
        <h2>Logs del servidor</h2>
        <p class="section-desc">
          Entradas de <code>daemon.log</code> (Pino NDJSON). Los logs son globales, no dependen del proyecto activo.
        </p>
      </div>
    </div>

    <div class="filters">
      <label class="filter">
        <span>Nivel</span>
        <select v-model="levelFilter" data-testid="server-logs-filter-level">
          <option v-for="opt in LEVEL_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <label class="filter">
        <span>Módulo</span>
        <input
          v-model="moduleFilter"
          type="text"
          placeholder="p.ej. server-logs"
          data-testid="server-logs-filter-module"
        />
      </label>
      <label class="filter filter--grow">
        <span>Buscar (msg)</span>
        <input
          v-model="searchInput"
          type="text"
          placeholder="Substring en msg…"
          data-testid="server-logs-filter-search"
        />
      </label>
      <label class="filter">
        <span>Desde</span>
        <input
          v-model="fromFilter"
          type="datetime-local"
          data-testid="server-logs-filter-from"
        />
      </label>
      <label class="filter">
        <span>Hasta</span>
        <input
          v-model="toFilter"
          type="datetime-local"
          data-testid="server-logs-filter-to"
        />
      </label>
      <div class="filter filter--action">
        <span>&nbsp;</span>
        <button
          type="button"
          class="btn-secondary"
          data-testid="server-logs-clear-filters"
          @click="clearFilters()"
        >
          Limpiar filtros
        </button>
      </div>
    </div>

    <div v-if="error" class="items-error">{{ error }}</div>

    <p v-if="!loading && !error && entries.length === 0" class="empty">
      No hay entradas para los filtros seleccionados.
    </p>

    <ul v-if="entries.length > 0" class="log-list">
      <li
        v-for="(entry, index) in entries"
        :key="entryKey(entry, index)"
        class="log-card"
        :class="{ 'log-card--open': expandedId === entryKey(entry, index) }"
      >
        <button
          type="button"
          class="log-row"
          :aria-expanded="expandedId === entryKey(entry, index)"
          @click="toggleRow(entryKey(entry, index))"
        >
          <span class="log-time">{{ formatDate(entry.time) }}</span>
          <span
            class="log-level"
            :style="{
              background: levelColor(entry.level).bg,
              color: levelColor(entry.level).fg,
            }"
          >{{ entry.level }}</span>
          <span class="log-module">{{ entry.module ?? '—' }}</span>
          <span class="log-msg">{{ truncateMsg(entry.msg) }}</span>
          <span class="log-chevron" aria-hidden="true">
            {{ expandedId === entryKey(entry, index) ? '▾' : '▸' }}
          </span>
        </button>

        <div v-if="expandedId === entryKey(entry, index)" class="log-detail">
          <div class="detail-header">
            <span class="detail-title">JSON completo</span>
            <button
              type="button"
              class="btn-copy"
              data-testid="server-logs-copy-json"
              @click="copyJson(entry)"
            >
              Copiar JSON
            </button>
          </div>
          <pre class="detail-json">{{ JSON.stringify(entry, null, 2) }}</pre>
        </div>
      </li>
    </ul>

    <div v-if="entries.length < total" class="load-more">
      <button
        type="button"
        class="btn-secondary"
        :disabled="loading"
        data-testid="server-logs-load-more"
        @click="loadMore()"
      >
        {{ loading ? 'Cargando…' : `Cargar más (${entries.length} / ${total})` }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.settings-section { border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem; }
.settings-section h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.section-desc { margin: 0 0 0.9rem; font-size: 0.82rem; color: #6b7280; line-height: 1.5; }
.section-desc code { background: #f3f4f6; padding: 0.05rem 0.35rem; border-radius: 3px; font-size: 0.78rem; }
.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.75rem; }

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
.filter--action { justify-content: flex-end; }
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

.log-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
.log-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
}
.log-card--open { border-color: #93c5fd; }

.log-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: 0.82rem;
  color: #111827;
}
.log-row:hover { background: #f9fafb; }

.log-time {
  flex-shrink: 0;
  min-width: 155px;
  font-variant-numeric: tabular-nums;
  color: #6b7280;
  font-size: 0.75rem;
}
.log-level {
  flex-shrink: 0;
  font-size: 0.7rem;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 600;
  text-transform: lowercase;
  min-width: 56px;
  text-align: center;
}
.log-module {
  flex-shrink: 0;
  min-width: 130px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  color: #4f46e5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log-msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-chevron { color: #9ca3af; font-size: 0.85rem; }

.log-detail {
  padding: 0.6rem 0.75rem 0.75rem;
  border-top: 1px solid #e5e7eb;
  background: #f9fafb;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.detail-header { display: flex; justify-content: space-between; align-items: center; }
.detail-title { font-size: 0.78rem; color: #6b7280; font-weight: 500; }
.detail-json {
  margin: 0;
  padding: 0.6rem 0.75rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  color: #111827;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 480px;
  overflow: auto;
}

.load-more { display: flex; justify-content: center; margin-top: 0.85rem; }
</style>
