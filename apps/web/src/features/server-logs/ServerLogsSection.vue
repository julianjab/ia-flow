<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { ServerLogLevel, ServerLogSort, ServerLogSortBy } from '@ia-flow/shared';
import { ServerLogEntrySchema } from '@ia-flow/shared';
import { useServerEvents } from '@/composables/useServerEvents';
import {
  fetchServerLogModules,
  fetchServerLogs,
  fetchServerLogSources,
  type ServerLogEntry,
  type ServerLogFilters,
  type ServerLogLevelCounts,
} from './api';

// Server-log levels available in the Zod enum. Empty string = "todos" (no
// filter). The summary chip row below is the only UI to toggle these.
type LevelFilter = '' | ServerLogLevel;
const KNOWN_LEVELS: ServerLogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

// Cap the modules chip row so a very diverse log file doesn't blow
// out the filter bar. 24 covers the daemon's ~15 core modules with
// headroom while still fitting on two-three lines on a laptop viewport.
const MODULE_CHIP_LIMIT = 24;

// Page size chosen to keep the /api/server-logs response small while still
// filling a typical screen. The route hard-caps at 1000.
const PAGE_LIMIT = 50;

// ─── Live tail ───────────────────────────────────────────────────────────
// Techo del buffer en memoria. Una sesión de diagnóstico larga contra un
// daemon ruidoso mete miles de líneas por hora; sin este corte la pestaña
// crece hasta que el navegador la mata. ~10 páginas es más de lo que nadie
// lee hacia atrás sin usar "Cargar más".
const LIVE_BUFFER_MAX = 500;
// Distancia desde el tope a partir de la cual se considera que el usuario
// está leyendo algo y no mirando la punta del stream. Mismo umbral que
// AUTOSCROLL_STICK_THRESHOLD_PX en ExecutionsSection.
const LIVE_STICK_THRESHOLD_PX = 40;

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
  return (KNOWN_LEVELS as string[]).includes(raw) ? (raw as ServerLogLevel) : '';
}
// Read a query param that may repeat (?module=a&module=b) into an array of
// non-empty strings. Vue Router preserves duplicated keys as string[].
function queryStrArr(key: string): string[] {
  const raw = route.query[key];
  if (typeof raw === 'string') return raw ? [raw] : [];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return [];
}
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
// Multi-select — which process (IA_FLOW_INSTANCE_ID) produced the line.
// Empty = the main daemon plus every forwarding container. Hydrates from
// ?source=a&source=b same as module.
const sourceFilter = ref<Set<string>>(new Set(queryStrArr('source').length > 0 ? queryStrArr('source') : (queryStr('source') ? [queryStr('source')] : [])));

// Full universe of modules present in daemon.log. Populated once on mount
// so the chip row shows every module that has ever logged — not just what's
// on the current page. If the endpoint fails (older server without it),
// discoveredModules below covers it.
const allModules = ref<string[]>([]);
async function loadAllModules() {
  try {
    allModules.value = await fetchServerLogModules();
  } catch {
    allModules.value = [];
  }
}
// Modules the UI has seen in ANY /api/server-logs response since mount.
// Accumulator-only — never shrinks — so applying a module filter (which
// drops all other modules from `entries`) doesn't collapse the chip row.
const discoveredModules = ref<Set<string>>(new Set());
// Same idea as allModules/discoveredModules, for extras.source.
const allSources = ref<string[]>([]);
async function loadAllSources() {
  try {
    allSources.value = await fetchServerLogSources();
  } catch {
    allSources.value = [];
  }
}
const discoveredSources = ref<Set<string>>(new Set());
const fromFilter = ref(toDatetimeLocal(queryStr('from')));
const toFilter = ref(toDatetimeLocal(queryStr('to')));
// Deep-link from ExecutionsSection → Logs tab: ?runId=X pins the view to
// a single agent run. Rendered as a removable pill above the filters.
const runIdFilter = ref(queryStr('runId'));

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
// Server logs have no stable id. La clave se asigna por IDENTIDAD de la
// entrada (WeakMap), no por su posición: el live tail inserta arriba, así
// que una clave "time-índice" correría todas las filas de lugar y la fila
// abierta pasaría a ser la de al lado en cada línea nueva.
const expandedId = ref<string | null>(null);

// Unified list of modules for the chip row. Merges three sources so the
// list never collapses when filters restrict the current page:
//   1. Full universe from GET /api/server-logs/modules (may be empty on
//      first mount or if the server hasn't restarted after the endpoint
//      was added).
//   2. Modules present in the currently loaded entries.
//   3. Modules the user has actively selected (so they can always toggle
//      them off).
const moduleChips = computed<string[]>(() => {
  const merged = new Set<string>();
  for (const m of allModules.value) merged.add(m);
  for (const m of discoveredModules.value) merged.add(m);
  for (const m of moduleFilter.value) merged.add(m);
  return Array.from(merged).sort((a, b) => a.localeCompare(b));
});
const sourceChips = computed<string[]>(() => {
  const merged = new Set<string>();
  for (const s of allSources.value) merged.add(s);
  for (const s of discoveredSources.value) merged.add(s);
  for (const s of sourceFilter.value) merged.add(s);
  return Array.from(merged).sort((a, b) => a.localeCompare(b));
});

function buildFilters(): ServerLogFilters {
  const f: ServerLogFilters = {
    limit: PAGE_LIMIT,
    offset: offset.value,
    sort: columnSort.value.direction,
    sortBy: columnSort.value.column,
  };
  if (levelFilter.value) f.level = levelFilter.value;
  if (moduleFilter.value.size > 0) f.module = Array.from(moduleFilter.value);
  if (sourceFilter.value.size > 0) f.source = Array.from(sourceFilter.value);
  if (searchApplied.value) f.search = searchApplied.value;
  if (fromFilter.value) f.from = new Date(fromFilter.value).toISOString();
  if (toFilter.value) f.to = new Date(toFilter.value).toISOString();
  if (runIdFilter.value) f.runId = runIdFilter.value;
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
    // Server-computed breakdown across all filters except the level one.
    levelCounts.value = data.levelCounts;
    // Accumulate every module we've ever seen in a response so filtering
    // by one module doesn't cause the other chips to vanish.
    const nextDiscovered = new Set(discoveredModules.value);
    for (const e of data.entries) if (e.module) nextDiscovered.add(e.module);
    if (nextDiscovered.size !== discoveredModules.value.size) {
      discoveredModules.value = nextDiscovered;
    }
    const nextDiscoveredSources = new Set(discoveredSources.value);
    for (const e of data.entries) {
      const source = e.extras?.source;
      if (typeof source === 'string' && source) nextDiscoveredSources.add(source);
    }
    if (nextDiscoveredSources.size !== discoveredSources.value.size) {
      discoveredSources.value = nextDiscoveredSources;
    }
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
  // Un refetch trae la ventana entera: lo que el live tail había dejado
  // pendiente ya viene adentro.
  pendingLive.value = 0;
  void load();
}

function loadMore() {
  offset.value += PAGE_LIMIT;
  void load();
}

function clearFilters() {
  levelFilter.value = '';
  moduleFilter.value = new Set();
  sourceFilter.value = new Set();
  searchInput.value = '';
  searchApplied.value = '';
  fromFilter.value = '';
  toFilter.value = '';
  runIdFilter.value = '';
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
function selectSourceChip(source: string) {
  const next = new Set(sourceFilter.value);
  if (next.has(source)) next.delete(source);
  else next.add(source);
  sourceFilter.value = next;
}
// Sortable columns delegated to the server: sortBy + sort direction go
// to /api/server-logs, which sorts the full filtered set before paging.
const columnSort = ref<{ column: ServerLogSortBy; direction: ServerLogSort }>({
  column: 'time',
  direction: 'desc',
});
function selectColumn(column: ServerLogSortBy) {
  if (columnSort.value.column === column) {
    columnSort.value = {
      column,
      direction: columnSort.value.direction === 'asc' ? 'desc' : 'asc',
    };
  } else {
    // First click on a new column always starts desc (newest/highest first).
    columnSort.value = { column, direction: 'desc' };
  }
}
function sortArrow(column: ServerLogSortBy): string {
  if (columnSort.value.column !== column) return '';
  return columnSort.value.direction === 'asc' ? ' ▲' : ' ▼';
}

// La clave se asigna la primera vez que se pide y sobrevive a cualquier
// reordenamiento del array. Se llama SIEMPRE desde el template, que ve el
// proxy reactivo de la entrada — un WeakMap cargado con el objeto crudo
// nunca daría hit desde ahí.
const entryKeys = new WeakMap<object, string>();
let entryKeySeq = 0;
function entryKey(entry: ServerLogEntry): string {
  const existing = entryKeys.get(entry);
  if (existing) return existing;
  entryKeySeq += 1;
  const key = `log-${entryKeySeq}`;
  entryKeys.set(entry, key);
  return key;
}

function toggleRow(id: string) {
  expandedId.value = expandedId.value === id ? null : id;
}

function copyJson(entry: ServerLogEntry) {
  void navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// Compact time column: HH:MM:SS.mmm when the log is from today (typical
// debug session), or "DD MMM HH:MM:SS" when it's from a previous day.
// Keeps every row's leading column narrow + monospace-aligned. Month name
// uses the browser's locale so a US machine reads "Jan" and es-* reads "ene".
const monthAbbrFormatter = new Intl.DateTimeFormat(undefined, { month: 'short' });
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
  return `${pad(d.getDate())} ${monthAbbrFormatter.format(d)} ${hms}`;
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

// Level counts served by /api/server-logs — computed over the full filtered
// set (ignoring the `level` filter) so summary chips are stable across
// pagination and reflect the true universe under the current filters.
const levelCounts = ref<ServerLogLevelCounts>({
  trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0,
});
const LEVEL_ORDER: ServerLogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

// Fixed palette per PRD — chosen so "warn" reads amber against white and
// "fatal" stays distinguishable from "error".
function levelColor(level: ServerLogLevel): { bg: string; fg: string } {
  switch (level) {
    case 'trace': return { bg: 'var(--fg-dim)', fg: 'var(--panel)' };
    case 'debug': return { bg: 'var(--info)', fg: 'var(--panel)' };
    case 'info':  return { bg: 'var(--accent)', fg: 'var(--panel)' };
    case 'warn':  return { bg: 'var(--warn)', fg: 'var(--panel)' };
    case 'error': return { bg: 'var(--danger)', fg: 'var(--panel)' };
    case 'fatal': return { bg: 'var(--danger)', fg: 'var(--panel)' };
  }
}

// ─── Live tail ───────────────────────────────────────────────────────────
// El daemon ya emite cada línea del logger por WS (`log:entry`); acá está el
// consumidor. Es el único lugar de la app donde se ven en vivo los logs SIN
// runId (webhooks, watcher, migraciones): el drawer de Ejecuciones descarta
// todo lo que no pertenezca a un run.
const liveMode = ref(true);
// El usuario se fue del tope: las entradas nuevas entran justo donde está
// mirando y le correrían el texto bajo el cursor. Se cuentan en vez de
// insertarse.
const pausedByScroll = ref(false);
// Entradas que matchearon los filtros pero no se insertaron (pausa por
// scroll, u orden no cronológico). El banner las ofrece con un refetch —
// contarlas es honesto, adivinar dónde iban no.
const pendingLive = ref(0);
// Con `sortBy` distinto de `time` el orden lo decide el server sobre el set
// completo; meter una fila arriba o abajo rompería ese orden. Se cuenta.
const liveInsertable = computed(() => columnSort.value.column === 'time');
const livePaused = computed(() => pausedByScroll.value || !liveInsertable.value);

// Mirror EXACTO del matcheo de apps/server/src/routes/server-logs.ts (el
// `for (const line of lines)`), separado en dos mitades por la misma razón
// que allá: `levelCounts` cuenta el universo IGNORANDO el filtro de nivel,
// mientras que `total` y la lista sí lo aplican.
function matchesNonLevelFilters(entry: ServerLogEntry): boolean {
  if (moduleFilter.value.size > 0 && (!entry.module || !moduleFilter.value.has(entry.module))) {
    return false;
  }
  if (sourceFilter.value.size > 0) {
    const source = entry.extras?.source;
    if (typeof source !== 'string' || !sourceFilter.value.has(source)) return false;
  }
  if (searchApplied.value && !entry.msg.includes(searchApplied.value)) return false;
  if (fromFilter.value && entry.time < new Date(fromFilter.value).toISOString()) return false;
  if (toFilter.value && entry.time > new Date(toFilter.value).toISOString()) return false;
  if (runIdFilter.value && entry.extras?.runId !== runIdFilter.value) return false;
  return true;
}

function mergeLiveEntry(entry: ServerLogEntry) {
  // El contador de nivel sube aunque el filtro de nivel descarte la fila:
  // es lo que el server devolvería en el próximo request.
  levelCounts.value = { ...levelCounts.value, [entry.level]: levelCounts.value[entry.level] + 1 };
  if (levelFilter.value && entry.level !== levelFilter.value) return;

  total.value += 1;
  const next =
    columnSort.value.direction === 'asc'
      ? entries.value.concat(entry)
      : [entry, ...entries.value];
  // Recorta por el extremo viejo, que es el opuesto al de inserción.
  entries.value =
    next.length > LIVE_BUFFER_MAX
      ? columnSort.value.direction === 'asc'
        ? next.slice(-LIVE_BUFFER_MAX)
        : next.slice(0, LIVE_BUFFER_MAX)
      : next;
  // Con orden descendente la entrada nueva también es la primera del set que
  // el server pagina, así que corre una posición todo lo que viene después:
  // sin este ajuste el próximo "Cargar más" repetiría una fila. En ascendente
  // aterriza al final, fuera de la ventana ya paginada, y el offset no se toca.
  if (columnSort.value.direction === 'desc') offset.value += 1;

  // Alimenta los chips sin re-pedir /modules ni /sources.
  if (entry.module && !discoveredModules.value.has(entry.module)) {
    discoveredModules.value = new Set(discoveredModules.value).add(entry.module);
  }
  const source = entry.extras?.source;
  if (typeof source === 'string' && source && !discoveredSources.value.has(source)) {
    discoveredSources.value = new Set(discoveredSources.value).add(source);
  }
}

const { connected: liveConnected } = useServerEvents((msg) => {
  if (!liveMode.value) return;
  if (msg.type !== 'log:entry') return;
  // safeParse acá y no en `api.ts`: el WS es la única entrada de datos de
  // esta pantalla que no pasa por la capa de red del feature, así que la
  // validación tiene que vivir donde el evento aterriza.
  const parsed = ServerLogEntrySchema.safeParse((msg as { entry?: unknown }).entry);
  if (!parsed.success) return;
  if (!matchesNonLevelFilters(parsed.data)) return;
  if (livePaused.value) {
    pendingLive.value += 1;
    return;
  }
  mergeLiveEntry(parsed.data);
});

function scrollToTopAndResume() {
  window.scrollTo({ top: 0 });
  pausedByScroll.value = false;
  resetAndLoad();
}

function onWindowScroll() {
  // La pantalla no tiene contenedor con overflow propio: el header sticky
  // del listado se pega contra el scroll del documento, así que el tope del
  // stream es el tope de la página.
  const paused = window.scrollY > LIVE_STICK_THRESHOLD_PX;
  if (paused === pausedByScroll.value) return;
  pausedByScroll.value = paused;
  // Volver al tope con deuda acumulada hace catch-up solo.
  if (!paused && pendingLive.value > 0) resetAndLoad();
}

// Reactivar el toggle después de un rato apagado deja la lista atrasada:
// lo que pasó mientras tanto no llegó por WS y nadie lo va a re-emitir.
watch(liveMode, (on) => {
  if (on) resetAndLoad();
});

// Refetch from scratch whenever a *server-side* filter changes. `searchInput`
// is intentionally not in this list — we watch `searchApplied` instead so the
// debounce is honoured.
watch(
  [levelFilter, moduleFilter, sourceFilter, searchApplied, fromFilter, toFilter, runIdFilter, columnSort],
  () => {
    resetAndLoad();
  },
);

onMounted(() => {
  void load();
  void loadAllModules();
  void loadAllSources();
  window.addEventListener('scroll', onWindowScroll, { passive: true });
});

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onWindowScroll);
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
      <div class="header-actions">
        <button
          type="button"
          class="live-toggle"
          :class="{
            'live-toggle--on': liveMode && liveConnected,
            'live-toggle--pending': liveMode && !liveConnected,
          }"
          :aria-pressed="liveMode"
          data-testid="server-logs-live-toggle"
          :title="
            liveMode
              ? liveConnected
                ? 'Live: las entradas nuevas aparecen solas'
                : 'Live: intentando reconectar…'
              : 'Live desactivado — la lista sólo cambia al recargar o filtrar'
          "
          @click="liveMode = !liveMode"
        >
          <span class="live-dot" aria-hidden="true"></span>
          Live
        </button>
      </div>
    </div>

    <div class="filters">
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

      <div v-if="sourceChips.length > 0" class="filter filter--chips">
        <span class="filter-label">
          Container
          <span class="filter-hint">({{ sourceFilter.size }}/{{ sourceChips.length }} activos)</span>
        </span>
        <div class="chips">
          <button
            v-for="s in sourceChips"
            :key="s"
            type="button"
            class="chip chip--module"
            :class="{ 'chip--active': sourceFilter.has(s) }"
            :aria-pressed="sourceFilter.has(s)"
            :data-testid="`server-logs-filter-source-chip-${s}`"
            @click="selectSourceChip(s)"
          >
            {{ s }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="error" class="items-error">{{ error }}</div>

    <div v-if="runIdFilter" class="log-runid-pill" data-testid="server-logs-runid-pill">
      <span class="log-runid-pill__label">Filtrado por run</span>
      <code class="log-runid-pill__value">{{ runIdFilter }}</code>
      <button
        type="button"
        class="log-runid-pill__clear"
        data-testid="server-logs-runid-clear"
        @click="runIdFilter = ''"
      >Quitar filtro ×</button>
    </div>

    <div class="log-summary" aria-label="Resumen por nivel">
      <span class="log-summary__total">{{ total }} entradas</span>
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

    <div
      v-if="liveMode && pendingLive > 0"
      class="live-banner"
      data-testid="server-logs-live-pending"
    >
      <span class="live-banner__count">
        {{ pendingLive }} {{ pendingLive === 1 ? 'entrada nueva' : 'entradas nuevas' }}
      </span>
      <span v-if="pausedByScroll" class="live-banner__why">
        stream pausado: estás leyendo fuera del tope
      </span>
      <span v-else class="live-banner__why">
        ordenado por {{ columnSort.column }}: insertar en vivo rompería el orden
      </span>
      <button
        v-if="pausedByScroll"
        type="button"
        class="live-banner__action"
        data-testid="server-logs-live-catchup"
        @click="scrollToTopAndResume()"
      >↑ Ir al tope</button>
      <button
        v-else
        type="button"
        class="live-banner__action"
        data-testid="server-logs-live-catchup"
        @click="resetAndLoad()"
      >↺ Recargar</button>
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
      <ul v-else class="log-list" data-kbd-list="server-logs">
        <li
          v-for="(entry, index) in entries"
          :key="entryKey(entry)"
          class="log-card"
          :class="[
            { 'log-card--open': expandedId === entryKey(entry) },
            `log-card--${entry.level}`,
            { 'log-card--zebra': index % 2 === 1 },
          ]"
        >
          <button
            type="button"
            class="log-row"
            data-kbd-item
            :aria-expanded="expandedId === entryKey(entry)"
            @click="toggleRow(entryKey(entry))"
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
              {{ expandedId === entryKey(entry) ? '▾' : '▸' }}
            </span>
          </button>

        <div v-if="expandedId === entryKey(entry)" class="log-detail">
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
.settings-section { border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
.settings-section h2 { margin: 0 0 0.35rem; font-size: 1.15rem; }
.section-desc { margin: 0 0 0.9rem; font-size: var(--fs-body-sm); color: var(--fg-mute); line-height: 1.55; }
.section-desc code { background: var(--panel-hi); padding: 0.05rem 0.35rem; border-radius: 3px; font-size: var(--fs-body-sm); }
.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.75rem; }

.btn-secondary {
  padding: 0.4rem 0.85rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  background: var(--panel);
  font-size: 0.85rem;
  color: var(--fg-mute);
  cursor: pointer;
}
.btn-secondary:hover { background: var(--panel-hi); }
.btn-secondary:disabled { opacity: 0.6; cursor: not-allowed; }

.btn-copy {
  padding: 0.25rem 0.65rem;
  border: 1px solid var(--border-hi);
  border-radius: 5px;
  background: var(--panel);
  font-size: 0.75rem;
  color: var(--fg-mute);
  cursor: pointer;
}
.btn-copy:hover { background: var(--panel-hi); }

.filters {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.65rem 0.75rem;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 0.85rem;
}
.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}
.filter { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.78rem; color: var(--fg-mute); min-width: 130px; }
.filter--grow { flex: 1; min-width: 200px; }
.filter--action { justify-content: flex-end; }
.filter--chips { gap: 0.3rem; }
.filter-label { font-weight: 500; color: var(--fg-dim); }
.filter-hint { font-weight: 400; color: var(--fg-dim); margin-left: 0.25rem; font-size: 0.72rem; }
.filter input, .filter select {
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border-hi);
  border-radius: 5px;
  font-size: 0.85rem;
  background: var(--panel);
  color: var(--fg);
}

.chips { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }
.chip {
  padding: 0.2rem 0.65rem;
  border: 1px solid var(--border-hi);
  border-radius: 999px;
  background: var(--panel);
  color: var(--fg-mute);
  font-size: 0.75rem;
  line-height: 1.2;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}
.chip:hover { background: var(--panel-hi); }
.chip--active { font-weight: 600; }
.chip--module {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.72rem;
  color: var(--info);
  border-color: var(--info);
  background: var(--panel-hi);
}
.chip--module:hover { background: var(--panel-hi); }
.chip--module.chip--active {
  background: var(--info);
  color: var(--panel);
  border-color: var(--info);
}
.chips-more { font-size: 0.72rem; color: var(--fg-dim); padding: 0.2rem 0.35rem; }

.empty { font-size: 0.875rem; color: var(--fg-dim); padding: 0.5rem 0; }
.items-error {
  padding: 0.6rem 0.85rem;
  background: transparent;
  border: 1px solid var(--danger);
  border-radius: 6px;
  font-size: 0.82rem;
  color: var(--danger);
  margin-bottom: 0.75rem;
}

/* ─── Deep-link pill (runId) ─────────────────────────────────────────── */
.log-runid-pill {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.45rem 0.7rem;
  margin-bottom: 0.5rem;
  border: 1px solid var(--info);
  background: var(--panel-hi);
  border-radius: 6px;
  font-size: 0.78rem;
  color: var(--info);
}
.log-runid-pill__label { font-weight: 600; }
.log-runid-pill__value {
  padding: 0.1rem 0.45rem;
  background: var(--panel);
  border: 1px solid var(--info);
  border-radius: 4px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  color: var(--fg);
}
.log-runid-pill__clear {
  margin-left: auto;
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--info);
  border-radius: 999px;
  background: var(--panel);
  color: var(--info);
  font-size: 0.72rem;
  cursor: pointer;
}
.log-runid-pill__clear:hover { background: var(--panel-hi); }

/* ─── Summary row (level counts) ─────────────────────────────────────── */
.log-summary {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.6rem;
  margin-bottom: 0.5rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: var(--fs-body-sm);
  flex-wrap: wrap;
}
.log-summary__total { color: var(--fg-dim); margin-right: 0.4rem; }
.log-summary__chip {
  padding: 0.2rem 0.65rem;
  border-radius: 999px;
  border: 1px solid transparent;
  cursor: pointer;
  font-size: var(--fs-chrome);
  text-transform: lowercase;
  line-height: 1.3;
  transition: transform 0.08s ease;
}
.log-summary__chip b { margin-left: 0.25rem; font-weight: 700; }
.log-summary__chip:hover { transform: translateY(-1px); }
.log-summary__chip[aria-pressed='true'] { outline: 2px solid var(--fg); outline-offset: 1px; }
.log-summary__chip--trace { background: transparent; color: var(--fg-mute); border-color: var(--border); }
.log-summary__chip--debug { background: transparent; color: var(--info); border-color: var(--border); }
.log-summary__chip--info  { background: transparent; color: var(--accent); border-color: var(--border); }
.log-summary__chip--warn  { background: transparent; color: var(--warn); border-color: var(--border); }
.log-summary__chip--error { background: transparent; color: var(--danger); border-color: var(--border); }
.log-summary__chip--fatal { background: transparent; color: var(--danger); border-color: var(--danger); font-weight: 700; }
.log-summary__chip--zero { opacity: 0.4; }
.log-summary__chip--zero:hover { opacity: 0.7; }

/* ─── Sticky column header ───────────────────────────────────────────── */
.log-list-wrapper { position: relative; }
.log-list-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  background: var(--panel-hi);
  border: 1px solid var(--border);
  border-radius: 6px 6px 0 0;
  font-size: var(--fs-chrome);
  font-weight: 600;
  color: var(--fg-mute);
  text-transform: uppercase;
  letter-spacing: var(--tracking-lbl);
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
.log-header-btn:hover { color: var(--fg); }
.log-header-btn--active { color: var(--fg); }
.log-empty {
  padding: 1.5rem 0.75rem;
  text-align: center;
  color: var(--fg-dim);
  font-size: 0.85rem;
  border: 1px solid var(--border);
  border-top: none;
  border-radius: 0 0 6px 6px;
  margin: 0;
}

.log-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.log-card {
  border: 1px solid var(--border);
  border-top: none;
  background: var(--panel);
  overflow: hidden;
}
.log-card:last-child { border-radius: 0 0 6px 6px; }
.log-card--zebra { background: var(--panel-alt); }
.log-card--open { border-color: var(--info); background: var(--panel-hi); }
/* Severity marker — a single-color left rail. No background tints on rows so
   text stays high-contrast; the rail alone signals the level. */
.log-card--warn  { box-shadow: inset 3px 0 0 0 var(--warn); }
.log-card--error { box-shadow: inset 3px 0 0 0 var(--danger); }
.log-card--fatal { box-shadow: inset 3px 0 0 0 var(--danger); }

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
  font-size: var(--fs-body-sm);
  line-height: 1.5;
  color: var(--fg);
}
.log-row:hover { background: var(--panel-hi); }

.log-time {
  flex-shrink: 0;
  min-width: 118px;
  font-variant-numeric: tabular-nums;
  color: var(--fg-dim);
  font-size: var(--fs-chrome);
  font-family: var(--font-mono);
}
.log-level {
  flex-shrink: 0;
  font-size: var(--fs-chrome);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 600;
  text-transform: lowercase;
  min-width: 56px;
  text-align: center;
}
.log-module {
  flex-shrink: 0;
  min-width: 140px;
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  color: var(--info);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log-msg { flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.4rem; overflow: hidden; }
.log-msg__text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-inline-chip {
  flex-shrink: 0;
  padding: 0.1rem 0.45rem;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: var(--fs-chrome);
  line-height: 1.4;
  border: 1px solid transparent;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log-inline-chip--runId  { background: var(--panel-hi); color: var(--info); border-color: var(--info); }
.log-inline-chip--taskId { background: var(--panel-hi); color: var(--info); border-color: var(--info); }
.log-inline-chip--agent  { background: var(--panel-hi); color: var(--ai); border-color: var(--ai); }
.log-inline-chip--event  { background: var(--panel-hi); color: var(--fg-mute); border-color: var(--border); }
.log-chevron { color: var(--fg-dim); font-size: 0.85rem; }

.log-detail {
  padding: 0.6rem 0.75rem 0.75rem;
  border-top: 1px solid var(--border);
  background: var(--panel-alt);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.detail-header { display: flex; justify-content: space-between; align-items: center; }
.detail-title { font-size: 0.78rem; color: var(--fg-dim); font-weight: 500; }
.detail-json {
  margin: 0;
  padding: 0.6rem 0.75rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 480px;
  overflow: auto;
}

.load-more { display: flex; justify-content: center; margin-top: 0.85rem; }

/* ─── Live tail ──────────────────────────────────────────────────────── */
.header-actions { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
.live-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.7rem;
  background: var(--panel);
  border: 1px solid var(--border-hi);
  font-size: var(--fs-chrome);
  color: var(--fg-dim);
  cursor: pointer;
}
.live-toggle:hover { background: var(--panel-hi); }
.live-toggle--on { background: var(--green-bg); border-color: var(--accent); color: var(--accent); }
.live-toggle--pending { background: var(--yellow-bg); border-color: var(--warn); color: var(--warn); }
/* `.live-dot` es primitiva global (theme.css): acá sólo se le cambia el color
   por estado. Apagado no parpadea — un punto latiendo diría "estoy recibiendo". */
.live-toggle .live-dot { background: var(--fg-dim); animation: none; }
.live-toggle--on .live-dot { background: var(--accent); animation: blink 1.6s ease-in-out infinite; }
.live-toggle--pending .live-dot { background: var(--warn); animation: blink 1.6s ease-in-out infinite; }

.live-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  margin-bottom: 0.5rem;
  background: var(--panel-hi);
  border: 1px solid var(--warn);
  font-size: var(--fs-chrome);
  color: var(--warn);
}
.live-banner__count { font-weight: 600; }
.live-banner__why { color: var(--fg-mute); }
.live-banner__action {
  margin-left: auto;
  padding: 0.2rem 0.6rem;
  background: var(--panel);
  border: 1px solid var(--warn);
  color: var(--warn);
  font-size: var(--fs-chrome);
  cursor: pointer;
}
.live-banner__action:hover { background: var(--panel-hi); }
</style>
