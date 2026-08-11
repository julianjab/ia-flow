<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { ServerLogLevel, ServerLogSort } from '@ia-flow/shared';
import { fetchServerLogs, type ServerLogEntry, type ServerLogFilters } from './api';

// Server-log levels available in the Zod enum. Empty string = "todos" (no
// filter). Order matches severity so it reads left-to-right in the chip row.
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

// Cap the "modules seen" chip row so a very diverse log file doesn't blow
// out the filter bar. 12 is enough to cover the current daemon modules
// with headroom while still fitting on two lines on a laptop viewport.
const MODULE_CHIP_LIMIT = 12;

// Page size chosen to keep the /api/server-logs response small while still
// filling a typical screen. The route hard-caps at 1000.
const PAGE_LIMIT = 50;

// ─── URL query hydration ─────────────────────────────────────────────────
// Deep links like /general/logs?search=…&from=…&to=… come from
// ExecutionsSection so the user can jump from an execution to the exact
// logs of that run. We read the query *once* at setup time (before the
// watchers below are registered) so hydrating a filter doesn't trigger a
// redundant resetAndLoad() on top of the onMounted() load.
const route = useRoute();
function queryStr(key: string): string {
  const raw = route.query[key];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return '';
}
function parseLevel(raw: string): LevelFilter {
  return LEVEL_OPTIONS.find((o) => o.value === raw)?.value ?? '';
}
// Read a query param that may repeat (?module=a&module=b) into an array of
// non-empty strings. Vue Router preserves duplicated keys as string[].
function queryStrArr(key: string): string[] {
  const raw = route.query[key];
  if (typeof raw === 'string') return raw ? [raw] : [];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return [];
}
function parseSort(raw: string): ServerLogSort {
  return raw === 'asc' ? 'asc' : 'desc';
}
const SORT_OPTIONS: { value: ServerLogSort; label: string }[] = [
  { value: 'desc', label: 'Más recientes primero' },
  { value: 'asc',  label: 'Más antiguos primero'  },
];
// Accepts either an ISO string (e.g. `2026-01-01T15:04:05.000Z`) or a raw
// `datetime-local` value (`YYYY-MM-DDTHH:mm`) and returns the shape that
// the `datetime-local` input expects, in local time. Empty when unparseable.
function toDatetimeLocal(raw: string): string {
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const levelFilter = ref<LevelFilter>(parseLevel(queryStr('level')));
// Multi-select — a Set of module names. Empty set = no module filter.
// Hydrates from ?module=a&module=b (repeated key) or a single ?module=a.
const moduleFilter = ref<Set<string>>(new Set(queryStrArr('module').length > 0 ? queryStrArr('module') : (queryStr('module') ? [queryStr('module')] : [])));
const moduleInput = ref('');
const fromFilter = ref(toDatetimeLocal(queryStr('from')));
const toFilter = ref(toDatetimeLocal(queryStr('to')));
const sortFilter = ref<ServerLogSort>(parseSort(queryStr('sort')));

// Debounced text search — `searchApplied` is what actually gets sent to the
// server so we don't refetch on every keystroke. When the URL preloads a
// search we skip the debounce (both refs start equal) so the first load
// already carries the filter.
const initialSearch = queryStr('search');
const searchInput = ref(initialSearch);
const searchApplied = ref(initialSearch);
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

// Unique module names present in the currently loaded entries — feeds both
// the `<datalist>` autocomplete and the discoverability chip row. Sorted
// alphabetically so the chip order is deterministic across reloads.
const moduleChips = computed<string[]>(() => {
  const seen = new Set<string>();
  for (const entry of entries.value) {
    if (entry.module) seen.add(entry.module);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
});

function buildFilters(): ServerLogFilters {
  const f: ServerLogFilters = { limit: PAGE_LIMIT, offset: offset.value, sort: sortFilter.value };
  if (levelFilter.value) f.level = levelFilter.value;
  if (moduleFilter.value.size > 0) f.module = Array.from(moduleFilter.value);
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
  moduleFilter.value = new Set();
  moduleInput.value = '';
  searchInput.value = '';
  searchApplied.value = '';
  fromFilter.value = '';
  toFilter.value = '';
  sortFilter.value = 'desc';
  // Watchers below will trigger resetAndLoad(); do it directly too so the
  // reset happens even when nothing changed (e.g. all filters already empty).
  resetAndLoad();
}

function selectLevel(value: LevelFilter) {
  // Toggle off if the user re-clicks an active chip (except "Todos", which
  // just re-selects itself). Keeps the chip row behaving like a group of
  // radio pills without needing a separate "clear level" affordance.
  if (value !== '' && levelFilter.value === value) {
    levelFilter.value = '';
    return;
  }
  levelFilter.value = value;
}

function selectModuleChip(module: string) {
  // Multi-select toggle: add if absent, remove if present. Re-assign the ref
  // so Vue picks up the change (Set mutations aren't reactive).
  const next = new Set(moduleFilter.value);
  if (next.has(module)) next.delete(module);
  else next.add(module);
  moduleFilter.value = next;
}
function addModuleFromInput() {
  const v = moduleInput.value.trim();
  if (!v) return;
  const next = new Set(moduleFilter.value);
  next.add(v);
  moduleFilter.value = next;
  moduleInput.value = '';
}
function removeModuleChip(module: string) {
  const next = new Set(moduleFilter.value);
  next.delete(module);
  moduleFilter.value = next;
}
function selectSort(value: ServerLogSort) {
  sortFilter.value = value;
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

// Inline style for a level chip: uses the level palette when selected,
// neutral otherwise. Kept out of the template to avoid a giant expression.
function levelChipStyle(value: LevelFilter): Record<string, string> {
  const active = levelFilter.value === value;
  if (!active) return {};
  if (value === '') {
    return { background: '#111827', color: '#ffffff', borderColor: '#111827' };
  }
  const c = levelColor(value);
  return { background: c.bg, color: c.fg, borderColor: c.bg };
}

// Refetch from scratch whenever a *server-side* filter changes. `searchInput`
// is intentionally not in this list — we watch `searchApplied` instead so the
// debounce is honoured.
watch([levelFilter, moduleFilter, searchApplied, fromFilter, toFilter, sortFilter], () => {
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
          Eventos del servidor de <code>daemon.log</code> (Pino NDJSON): orchestrator, watcher, migraciones, GitHub, WebSockets, etc.
          Para debug de una ejecución específica (request/response, tool calls) usa la fila expandible en
          <strong>Proyecto → Ejecuciones</strong>.
        </p>
      </div>
    </div>

    <div class="filters">
      <div class="filter filter--chips" data-testid="server-logs-filter-level">
        <span class="filter-label">Nivel</span>
        <div class="chips" role="radiogroup" aria-label="Filtrar por nivel">
          <button
            v-for="opt in LEVEL_OPTIONS"
            :key="opt.value || 'all'"
            type="button"
            class="chip"
            :class="{ 'chip--active': levelFilter === opt.value }"
            :style="levelChipStyle(opt.value)"
            :aria-pressed="levelFilter === opt.value"
            :data-testid="`server-logs-filter-level-chip-${opt.value || 'all'}`"
            @click="selectLevel(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div class="filter-row">
        <label class="filter">
          <span class="filter-label">Agregar módulo</span>
          <input
            v-model="moduleInput"
            type="text"
            placeholder="p.ej. anthropic-api"
            list="server-logs-module-options"
            data-testid="server-logs-filter-module"
            @keydown.enter.prevent="addModuleFromInput()"
          />
          <datalist id="server-logs-module-options">
            <option v-for="m in moduleChips" :key="m" :value="m" />
          </datalist>
        </label>
        <label class="filter filter--grow">
          <span class="filter-label">Buscar (msg)</span>
          <input
            v-model="searchInput"
            type="text"
            placeholder="Substring en msg…"
            data-testid="server-logs-filter-search"
          />
        </label>
        <label class="filter">
          <span class="filter-label">Desde</span>
          <input
            v-model="fromFilter"
            type="datetime-local"
            data-testid="server-logs-filter-from"
          />
        </label>
        <label class="filter">
          <span class="filter-label">Hasta</span>
          <input
            v-model="toFilter"
            type="datetime-local"
            data-testid="server-logs-filter-to"
          />
        </label>
        <div class="filter filter--action">
          <span class="filter-label">&nbsp;</span>
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

      <div class="filter filter--chips" data-testid="server-logs-filter-sort">
        <span class="filter-label">Orden</span>
        <div class="chips" role="radiogroup" aria-label="Orden de los logs">
          <button
            v-for="opt in SORT_OPTIONS"
            :key="opt.value"
            type="button"
            class="chip"
            :class="{ 'chip--active': sortFilter === opt.value }"
            :aria-pressed="sortFilter === opt.value"
            :data-testid="`server-logs-filter-sort-chip-${opt.value}`"
            @click="selectSort(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div v-if="moduleFilter.size > 0" class="filter filter--chips">
        <span class="filter-label">
          Módulos activos
          <span class="filter-hint">(click para quitar)</span>
        </span>
        <div class="chips">
          <button
            v-for="m in Array.from(moduleFilter)"
            :key="`active-${m}`"
            type="button"
            class="chip chip--module chip--active"
            :data-testid="`server-logs-filter-module-active-${m}`"
            @click="removeModuleChip(m)"
          >
            {{ m }} ×
          </button>
        </div>
      </div>

      <div v-if="moduleChips.length > 0" class="filter filter--chips">
        <span class="filter-label">
          Módulos visibles
          <span class="filter-hint">(click para (des)seleccionar)</span>
        </span>
        <div class="chips">
          <button
            v-for="m in moduleChips.slice(0, MODULE_CHIP_LIMIT)"
            :key="m"
            type="button"
            class="chip chip--module"
            :class="{ 'chip--active': moduleFilter.has(m) }"
            :aria-pressed="moduleFilter.has(m)"
            :data-testid="`server-logs-filter-module-chip-${m}`"
            @click="selectModuleChip(m)"
          >
            {{ m }}
          </button>
          <span v-if="moduleChips.length > MODULE_CHIP_LIMIT" class="chips-more">
            +{{ moduleChips.length - MODULE_CHIP_LIMIT }} más…
          </span>
        </div>
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
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.65rem 0.75rem;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  margin-bottom: 0.85rem;
}
.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}
.filter { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.78rem; color: #374151; min-width: 130px; }
.filter--grow { flex: 1; min-width: 200px; }
.filter--action { justify-content: flex-end; }
.filter--chips { gap: 0.3rem; }
.filter-label { font-weight: 500; color: #6b7280; }
.filter-hint { font-weight: 400; color: #9ca3af; margin-left: 0.25rem; font-size: 0.72rem; }
.filter input, .filter select {
  padding: 0.3rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 5px;
  font-size: 0.85rem;
  background: #fff;
  color: #111827;
}

.chips { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }
.chip {
  padding: 0.2rem 0.65rem;
  border: 1px solid #d1d5db;
  border-radius: 999px;
  background: #ffffff;
  color: #374151;
  font-size: 0.75rem;
  line-height: 1.2;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}
.chip:hover { background: #f3f4f6; }
.chip--active { font-weight: 600; }
.chip--module {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.72rem;
  color: #4f46e5;
  border-color: #c7d2fe;
  background: #eef2ff;
}
.chip--module:hover { background: #e0e7ff; }
.chip--module.chip--active {
  background: #4f46e5;
  color: #ffffff;
  border-color: #4f46e5;
}
.chips-more { font-size: 0.72rem; color: #9ca3af; padding: 0.2rem 0.35rem; }

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
