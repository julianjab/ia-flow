<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { ServerLogLevel, ServerLogSort } from '@ia-flow/shared';
import {
  fetchServerLogModules,
  fetchServerLogs,
  type ServerLogEntry,
  type ServerLogFilters,
} from './api';

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

// Cap the modules chip row so a very diverse log file doesn't blow
// out the filter bar. 24 covers the daemon's ~15 core modules with
// headroom while still fitting on two-three lines on a laptop viewport.
const MODULE_CHIP_LIMIT = 24;

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

// Full universe of modules present in daemon.log. Populated once on mount
// (and refreshable) so the chip row shows every module that has ever
// logged — not just what's on the current page.
const allModules = ref<string[]>([]);
async function loadAllModules() {
  try {
    allModules.value = await fetchServerLogModules();
  } catch {
    // Non-fatal: fall back to page-derived moduleChips below.
    allModules.value = [];
  }
}
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

// Unified list of modules for the chip row: prefer the server-side full
// universe (allModules), fall back to what's derived from the current
// page. Adds any actively-selected module that's no longer present in the
// list so the user can always toggle it off.
const moduleChips = computed<string[]>(() => {
  const base = allModules.value.length > 0
    ? [...allModules.value]
    : Array.from(new Set(entries.value.map((e) => e.module).filter((m): m is string => !!m)));
  for (const m of moduleFilter.value) {
    if (!base.includes(m)) base.push(m);
  }
  return base.sort((a, b) => a.localeCompare(b));
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
  searchInput.value = '';
  searchApplied.value = '';
  fromFilter.value = '';
  toFilter.value = '';
  sortFilter.value = 'desc';
  columnSort.value = { column: 'time', direction: 'desc' };
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
function selectSort(value: ServerLogSort) {
  sortFilter.value = value;
}

// Client-side column sorting over the currently loaded page. For the
// "time" column we defer to the server-side sortFilter so pagination keeps
// working; for level/module/msg we sort in-memory.
type SortColumn = 'time' | 'level' | 'module' | 'msg';
const columnSort = ref<{ column: SortColumn; direction: 'asc' | 'desc' }>({
  column: 'time',
  direction: 'desc',
});
function selectColumn(column: SortColumn) {
  if (column === 'time') {
    // Toggle server-side sort direction; keep columnSort in sync so the
    // header arrow reflects it.
    const next: ServerLogSort = sortFilter.value === 'desc' ? 'asc' : 'desc';
    sortFilter.value = next;
    columnSort.value = { column: 'time', direction: next };
    return;
  }
  if (columnSort.value.column === column) {
    columnSort.value = {
      column,
      direction: columnSort.value.direction === 'asc' ? 'desc' : 'asc',
    };
  } else {
    // First click on a new column always starts desc (newest / highest first)
    // to match the default reading direction.
    columnSort.value = { column, direction: 'desc' };
  }
}
function sortArrow(column: SortColumn): string {
  if (columnSort.value.column !== column) return '';
  return columnSort.value.direction === 'asc' ? ' ▲' : ' ▼';
}

const LEVEL_RANK: Record<ServerLogLevel, number> = {
  trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5,
};
const sortedEntries = computed<ServerLogEntry[]>(() => {
  const { column, direction } = columnSort.value;
  if (column === 'time') return entries.value;
  const arr = [...entries.value];
  const dir = direction === 'asc' ? 1 : -1;
  arr.sort((a, b) => {
    let cmp = 0;
    if (column === 'level') cmp = LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
    else if (column === 'module') cmp = (a.module ?? '').localeCompare(b.module ?? '');
    else if (column === 'msg') cmp = a.msg.localeCompare(b.msg);
    return cmp * dir;
  });
  return arr;
});

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

// Compact time column: HH:MM:SS.mmm when the log is from today (typical
// debug session), or "DD MMM HH:MM:SS" when it's from a previous day.
// Keeps every row's leading column narrow + monospace-aligned.
const MONTH_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function formatTimeCompact(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (sameDay) return `${hms}.${pad(d.getMilliseconds(), 3)}`;
  return `${pad(d.getDate())} ${MONTH_ABBR[d.getMonth()]} ${hms}`;
}

const MSG_TRUNCATE = 120;
function truncateMsg(msg: string): string {
  return msg.length > MSG_TRUNCATE ? `${msg.slice(0, MSG_TRUNCATE)}…` : msg;
}

// Inline chips shown after the message when the extras carry correlation ids.
// Order matters: runId → taskId → agent → event; skipped when absent.
interface InlineChip { label: string; value: string; kind: 'runId' | 'taskId' | 'agent' | 'event' }
function extractChips(entry: ServerLogEntry): InlineChip[] {
  const ex = entry.extras;
  if (!ex) return [];
  const chips: InlineChip[] = [];
  const runId = ex.runId;
  if (typeof runId === 'string' && runId) chips.push({ label: 'run', value: runId, kind: 'runId' });
  const taskId = ex.taskId;
  if (typeof taskId === 'string' && taskId) {
    chips.push({ label: 'task', value: taskId.length > 20 ? `${taskId.slice(0, 18)}…` : taskId, kind: 'taskId' });
  }
  const agent = ex.agent;
  if (typeof agent === 'string' && agent) chips.push({ label: 'agent', value: agent, kind: 'agent' });
  const event = ex.event;
  if (typeof event === 'string' && event) chips.push({ label: 'evt', value: event, kind: 'event' });
  return chips;
}

// Level counts across the current page — powers the summary badge row.
const levelCounts = computed<Record<ServerLogLevel, number>>(() => {
  const counts: Record<ServerLogLevel, number> = {
    trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0,
  };
  for (const e of entries.value) counts[e.level]++;
  return counts;
});
const LEVEL_ORDER: ServerLogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

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
  void loadAllModules();
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

      <div v-if="moduleChips.length > 0" class="filter filter--chips">
        <span class="filter-label">
          Módulos
          <span class="filter-hint">({{ moduleFilter.size }}/{{ moduleChips.length }} activos)</span>
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

    <div class="log-summary" aria-label="Resumen por nivel">
      <span class="log-summary__total">{{ entries.length }} entradas</span>
      <button
        v-for="lvl in LEVEL_ORDER"
        :key="lvl"
        type="button"
        class="log-summary__chip"
        :class="[
          `log-summary__chip--${lvl}`,
          { 'log-summary__chip--zero': levelCounts[lvl] === 0 },
        ]"
        :aria-pressed="levelFilter === lvl"
        :data-testid="`server-logs-summary-${lvl}`"
        @click="selectLevel(lvl)"
      >
        {{ lvl }} <b>{{ levelCounts[lvl] }}</b>
      </button>
    </div>

    <div class="log-list-wrapper">
      <div class="log-list-header" role="row">
        <button
          type="button"
          class="log-time log-header-btn"
          :class="{ 'log-header-btn--active': columnSort.column === 'time' }"
          data-testid="server-logs-sort-time"
          @click="selectColumn('time')"
        >Fecha{{ sortArrow('time') }}</button>
        <button
          type="button"
          class="log-level-col log-header-btn"
          :class="{ 'log-header-btn--active': columnSort.column === 'level' }"
          data-testid="server-logs-sort-level"
          @click="selectColumn('level')"
        >Nivel{{ sortArrow('level') }}</button>
        <button
          type="button"
          class="log-module log-header-btn"
          :class="{ 'log-header-btn--active': columnSort.column === 'module' }"
          data-testid="server-logs-sort-module"
          @click="selectColumn('module')"
        >Módulo{{ sortArrow('module') }}</button>
        <button
          type="button"
          class="log-msg log-header-btn"
          :class="{ 'log-header-btn--active': columnSort.column === 'msg' }"
          data-testid="server-logs-sort-msg"
          @click="selectColumn('msg')"
        >Mensaje{{ sortArrow('msg') }}</button>
        <span class="log-chevron"></span>
      </div>
      <p v-if="entries.length === 0 && !loading" class="log-empty">
        No hay entradas para los filtros seleccionados.
      </p>
      <p v-else-if="entries.length === 0 && loading" class="log-empty">
        Cargando…
      </p>
      <ul v-else class="log-list">
        <li
          v-for="(entry, index) in sortedEntries"
          :key="entryKey(entry, index)"
          class="log-card"
          :class="[
            { 'log-card--open': expandedId === entryKey(entry, index) },
            `log-card--${entry.level}`,
            { 'log-card--zebra': index % 2 === 1 },
          ]"
        >
          <button
            type="button"
            class="log-row"
            :aria-expanded="expandedId === entryKey(entry, index)"
            @click="toggleRow(entryKey(entry, index))"
          >
            <span class="log-time" :title="formatDate(entry.time)">{{ formatTimeCompact(entry.time) }}</span>
            <span
              class="log-level"
              :style="{
                background: levelColor(entry.level).bg,
                color: levelColor(entry.level).fg,
              }"
            >{{ entry.level }}</span>
            <span class="log-module">{{ entry.module ?? '—' }}</span>
            <span class="log-msg">
              <span class="log-msg__text">{{ truncateMsg(entry.msg) }}</span>
              <span
                v-for="chip in extractChips(entry)"
                :key="`${chip.kind}-${chip.value}`"
                class="log-inline-chip"
                :class="`log-inline-chip--${chip.kind}`"
                :title="`${chip.label}: ${chip.value}`"
              >{{ chip.label }}:{{ chip.value }}</span>
            </span>
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
    </div>

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

/* ─── Summary row (level counts) ─────────────────────────────────────── */
.log-summary {
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
.log-summary__total { color: #6b7280; margin-right: 0.4rem; }
.log-summary__chip {
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  border: 1px solid transparent;
  cursor: pointer;
  font-size: 0.72rem;
  text-transform: lowercase;
  line-height: 1.2;
  transition: transform 0.08s ease;
}
.log-summary__chip b { margin-left: 0.25rem; font-weight: 700; }
.log-summary__chip:hover { transform: translateY(-1px); }
.log-summary__chip[aria-pressed='true'] { outline: 2px solid #111827; outline-offset: 1px; }
.log-summary__chip--trace { background: #f3f4f6; color: #4b5563; }
.log-summary__chip--debug { background: #dbeafe; color: #1e40af; }
.log-summary__chip--info  { background: #dcfce7; color: #14532d; }
.log-summary__chip--warn  { background: #fef3c7; color: #78350f; }
.log-summary__chip--error { background: #fee2e2; color: #7f1d1d; }
.log-summary__chip--fatal { background: #fecaca; color: #450a0a; font-weight: 700; }
.log-summary__chip--zero { opacity: 0.4; }
.log-summary__chip--zero:hover { opacity: 0.7; }

/* ─── Sticky column header ───────────────────────────────────────────── */
.log-list-wrapper { position: relative; }
.log-list-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 0.75rem;
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
.log-list-header .log-level-col {
  flex-shrink: 0;
  min-width: 56px;
  text-align: center;
}
.log-header-btn {
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
.log-header-btn:hover { color: #111827; }
.log-header-btn--active { color: #111827; }
.log-empty {
  padding: 1.5rem 0.75rem;
  text-align: center;
  color: #9ca3af;
  font-size: 0.85rem;
  border: 1px solid #e5e7eb;
  border-top: none;
  border-radius: 0 0 6px 6px;
  margin: 0;
}

.log-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.log-card {
  border: 1px solid #e5e7eb;
  border-top: none;
  background: #fff;
  overflow: hidden;
}
.log-card:last-child { border-radius: 0 0 6px 6px; }
.log-card--zebra { background: #fafafa; }
.log-card--open { border-color: #93c5fd; background: #eff6ff; }
/* Subtle severity tint — kept low contrast so info rows remain dominant. */
.log-card--warn  { background: #fffbeb; }
.log-card--warn.log-card--zebra { background: #fef7dc; }
.log-card--error { background: #fef2f2; }
.log-card--error.log-card--zebra { background: #fde8e8; }
.log-card--fatal { background: #fee2e2; }

.log-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.4rem 0.75rem;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: 0.82rem;
  color: #111827;
}
.log-row:hover { background: rgba(0, 0, 0, 0.035); }

.log-time {
  flex-shrink: 0;
  min-width: 118px;
  font-variant-numeric: tabular-nums;
  color: #6b7280;
  font-size: 0.72rem;
  font-family: 'SF Mono', 'Fira Code', monospace;
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
.log-msg { flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.4rem; overflow: hidden; }
.log-msg__text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-inline-chip {
  flex-shrink: 0;
  padding: 0.05rem 0.4rem;
  border-radius: 3px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.68rem;
  line-height: 1.4;
  border: 1px solid transparent;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log-inline-chip--runId  { background: #eef2ff; color: #3730a3; border-color: #c7d2fe; }
.log-inline-chip--taskId { background: #ecfeff; color: #155e75; border-color: #a5f3fc; }
.log-inline-chip--agent  { background: #fdf4ff; color: #86198f; border-color: #f5d0fe; }
.log-inline-chip--event  { background: #f5f5f4; color: #44403c; border-color: #d6d3d1; }
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
