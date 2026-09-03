<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import FilterQueryInput from '@/ui/FilterQueryInput.vue';
import { type FilterFieldDef, type FilterToken, isDateValue } from '@/ui/filter-query';
import { useRoute } from 'vue-router';
import type { ServerLogLevel, ServerLogSort, ServerLogSortBy } from '@ia-flow/shared';
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
// Los tres campos de `extras` que dicen de QUIÉN es una línea: el agente que la
// escribió, el issue sobre el que trabajaba y su proyecto. Multi-select como
// module/source: dos valores del mismo campo se suman.
const agentFilter = ref<Set<string>>(new Set(queryStrArr('agentId')));
const taskFilter = ref<Set<string>>(new Set(queryStrArr('taskId')));
// El título de la tarea (`extras.task`) — sólo lo estampa el camino sync
// (AnthropicApiProvider), al lado del `taskId` opaco. Mismo patrón multi-select.
const taskTitleFilter = ref<Set<string>>(new Set(queryStrArr('task')));
const projectFilter = ref<Set<string>>(new Set(queryStrArr('projectId')));
// La regla es lo único que correlaciona las líneas de una ACCIÓN, y es el link
// con el que la tarjeta de una acción manda para acá.
const ruleFilter = ref<Set<string>>(new Set(queryStrArr('ruleId')));
// `runId` deja de ser uno solo: es el mismo campo que los de arriba y no hay
// razón para que no se puedan mirar dos corridas juntas.
const runFilter = ref<Set<string>>(new Set(queryStr('runId') ? [queryStr('runId')] : []));
// Búsqueda por regexp sobre CUALQUIER campo de `extras`, no sólo los seis con
// selector propio arriba — cada token es `<clave>:<regexp>`
// (`extra:err:ECONNRESET`, `extra:clearDedupe:^http`). Multi-select: varios
// tokens se exigen todos a la vez, igual que agente/tarea/etc.
const extraFilter = ref<Set<string>>(new Set(queryStrArr('extra')));

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
// Para agente/tarea/proyecto no hay endpoint que liste el universo: los valores
// salen de las líneas cargadas más lo que ya esté filtrado (para que el token
// activo se siga sugiriendo). Por eso los tres son `free`: uno que no esté en la
// página se puede tipear igual — es lo que hace útil pegar un taskId de otra
// pantalla.
const discoveredExtras = ref<Record<string, Set<string>>>({
  agentId: new Set(),
  taskId: new Set(),
  task: new Set(),
  ruleId: new Set(),
  projectId: new Set(),
  runId: new Set(),
});
function extraValues(key: string, active: Set<string>): string[] {
  const merged = new Set(discoveredExtras.value[key] ?? []);
  for (const v of active) merged.add(v);
  return Array.from(merged).sort((a, b) => a.localeCompare(b));
}
const fromFilter = ref(toDatetimeLocal(queryStr('from')));
const toFilter = ref(toDatetimeLocal(queryStr('to')));

// ─── Columnas de `extras` — al estilo Datadog: "..." en un campo del detalle
// agrega/quita ese campo como columna de la tabla. Preferencia por-viewer:
// vive en localStorage, no en el server (dos pestañas de dos operadores
// pueden mirar columnas distintas del mismo log).
const COLUMNS_STORAGE_KEY = 'ia-flow:server-logs:columns';
const COLUMN_LABELS: Record<string, string> = {
  agentId: 'Agente',
  taskId: 'Tarea',
  task: 'Título',
  projectId: 'Proyecto',
  ruleId: 'Regla',
  runId: 'Run',
  source: 'Contenedor',
};
function columnLabel(key: string): string {
  return COLUMN_LABELS[key] ?? key;
}
function loadStoredColumns(): string[] {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
const activeColumns = ref<string[]>(loadStoredColumns());
function persistColumns(): void {
  try {
    localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(activeColumns.value));
  } catch {
    // Storage lleno o bloqueado (ventana privada) — la preferencia no
    // persiste, pero la columna se ve igual en esta sesión.
  }
}
function isColumnActive(key: string): boolean {
  return activeColumns.value.includes(key);
}
function toggleColumn(key: string): void {
  activeColumns.value = isColumnActive(key)
    ? activeColumns.value.filter((k) => k !== key)
    : [...activeColumns.value, key];
  persistColumns();
}
function removeColumn(key: string): void {
  if (!isColumnActive(key)) return;
  activeColumns.value = activeColumns.value.filter((k) => k !== key);
  persistColumns();
}
// Todas las claves de `extras` vistas en CUALQUIER línea desde que se montó
// el panel — alimenta el picker de "+ columna" del header. Acumulador, igual
// que discoveredModules: nunca encoge, así que sacar un filtro no vacía las
// opciones.
const discoveredExtraKeys = ref<Set<string>>(new Set());
const addColumnMenuOpen = ref(false);
function addableColumns(): string[] {
  return Array.from(discoveredExtraKeys.value)
    .filter((k) => !isColumnActive(k))
    .sort((a, b) => columnLabel(a).localeCompare(columnLabel(b)));
}
function addColumn(key: string): void {
  if (isColumnActive(key)) return;
  activeColumns.value = [...activeColumns.value, key];
  persistColumns();
  addColumnMenuOpen.value = false;
}

// ─── El menú "..." de un campo, dentro del detalle expandido de una línea ──
// Un solo ref global (no por-fila): a lo sumo un menú abierto a la vez, así
// que no hace falta un Set ni una key compuesta.
const openFieldMenu = ref<string | null>(null);
function fieldMenuId(entryId: string, key: string): string {
  return `${entryId}::${key}`;
}
function toggleFieldMenu(id: string): void {
  openFieldMenu.value = openFieldMenu.value === id ? null : id;
}
function closeMenus(): void {
  openFieldMenu.value = null;
  addColumnMenuOpen.value = false;
}
// Cierra cualquier menú abierto al clickear afuera — los toggles paran la
// propagación (`@click.stop`), así que sólo un click que NO vino de un menú
// llega hasta acá.
onMounted(() => window.addEventListener('click', closeMenus));
onUnmounted(() => window.removeEventListener('click', closeMenus));


// `searchApplied` es lo que se manda al servidor. Ya no hay debounce: el texto
// entra como token (`msg:…`), y el token ES la confirmación explícita — antes el
// input escribía en cada tecla y había que esperar a que el operador parara.
const initialSearch = queryStr('search');
const searchInput = ref(initialSearch);
const searchApplied = ref(initialSearch);

const entries = ref<ServerLogEntry[]>([]);
const total = ref(0);
const offset = ref(0);
const loading = ref(false);
const error = ref<string>('');
// Server logs have no stable id, so we key by "time-index" using the position
// within the current accumulated list. It's stable across the render cycle
// because we only append (never re-order) results.
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

// ─── Los filtros, como un solo input `campo:valor` ────────────────────────
//
// Los refs de arriba siguen siendo la fuente de verdad —los leen `buildFilters`
// y los watchers que refetchean—; el input es una VISTA de ellos. Reemplazó a
// dos grupos de chips (uno de ellos con su propio buscador y su "+N más", que
// existían sólo porque 40 módulos no entran en una fila) más la píldora del
// runId y los tres campos de texto.
const FILTER_FIELDS: Array<{
  key: string;
  hint?: string;
  values?: () => string[];
  free?: boolean;
  validate?: (value: string) => boolean;
}> = [
  // Cerrado sólo el nivel: es el enum que el servidor valida, así que un valor
  // inventado sería un 400 y no una lista vacía. Todo lo demás se DESCUBRE —de
  // un endpoint que puede no existir en un server viejo, o de las líneas ya
  // cargadas— así que acepta lo que no conoce: una lista vacía no puede dejar
  // un campo sin forma de filtrar.
  { key: 'nivel', hint: 'severidad', values: () => [...KNOWN_LEVELS] },
  { key: 'modulo', hint: 'qué parte del daemon', values: () => moduleChips.value, free: true },
  {
    key: 'container',
    hint: 'qué proceso lo produjo',
    values: () => sourceChips.value,
    free: true,
  },
  {
    key: 'agente',
    hint: 'quién escribió la línea',
    values: () => extraValues('agentId', agentFilter.value),
    free: true,
  },
  {
    key: 'tarea',
    hint: 'sobre qué issue',
    values: () => extraValues('taskId', taskFilter.value),
    free: true,
  },
  {
    key: 'titulo',
    hint: 'título de la tarea',
    values: () => extraValues('task', taskTitleFilter.value),
    free: true,
  },
  {
    key: 'proyecto',
    hint: 'de qué board',
    values: () => extraValues('projectId', projectFilter.value),
    free: true,
  },
  {
    key: 'regla',
    hint: 'qué regla lo produjo',
    values: () => extraValues('ruleId', ruleFilter.value),
    free: true,
  },
  {
    key: 'run',
    hint: 'id de una ejecución',
    values: () => extraValues('runId', runFilter.value),
    free: true,
  },
  { key: 'msg', hint: 'contains del mensaje, sin caja (*/? comodines)', free: true },
  {
    key: 'extra',
    hint: 'patrón sobre cualquier campo de extras (*/? comodines) — o clave:patrón para acotar a uno, ej. err:ECONNRESET',
    free: true,
    // No es una regexp arbitraria (ver el comentario de `extra` en
    // ServerLogFiltersSchema y `globMatchFull` en server-logs.ts) — sólo
    // `*`/`?` como comodines. Sin `:` busca en CUALQUIER campo de extras;
    // con `:` acota a una clave. El tope espeja MAX_EXTRA_PATTERN_LEN del
    // server.
    validate: (v) => {
      const trimmed = v.trim();
      const at = trimmed.indexOf(':');
      if (at === 0) return false; // ":algo" — clave vacía explícita
      const pattern = at < 0 ? trimmed : trimmed.slice(at + 1).trim();
      return pattern.length > 0 && pattern.length <= 200;
    },
  },
  { key: 'desde', hint: 'AAAA-MM-DDTHH:mm', free: true, validate: isDateValue },
  { key: 'hasta', hint: 'AAAA-MM-DDTHH:mm', free: true, validate: isDateValue },
];

const filterFields = computed<FilterFieldDef[]>(() =>
  FILTER_FIELDS.map((f) => ({
    key: f.key,
    hint: f.hint,
    values: f.values?.(),
    free: f.free,
    validate: f.validate,
  })),
);

function setTokens(field: string, values: string[]): FilterToken[] {
  return values.map((value) => ({ field, value }));
}

/** Escribe el Set sólo si CAMBIÓ: un `new Set()` con el mismo contenido es otra
 *  identidad, y los watchers que refetchean miran identidad. */
function assignSet(target: { value: Set<string> }, values: string[]): void {
  const next = new Set(values);
  if (next.size === target.value.size && values.every((v) => target.value.has(v))) return;
  target.value = next;
}

const filterTokens = computed<FilterToken[]>({
  get: () => [
    ...setTokens('nivel', levelFilter.value ? [levelFilter.value] : []),
    ...setTokens('modulo', Array.from(moduleFilter.value)),
    ...setTokens('container', Array.from(sourceFilter.value)),
    ...setTokens('agente', Array.from(agentFilter.value)),
    ...setTokens('tarea', Array.from(taskFilter.value)),
    ...setTokens('titulo', Array.from(taskTitleFilter.value)),
    ...setTokens('proyecto', Array.from(projectFilter.value)),
    ...setTokens('regla', Array.from(ruleFilter.value)),
    ...setTokens('run', Array.from(runFilter.value)),
    ...setTokens('extra', Array.from(extraFilter.value)),
    ...setTokens('msg', searchInput.value ? [searchInput.value] : []),
    ...setTokens('desde', fromFilter.value ? [fromFilter.value] : []),
    ...setTokens('hasta', toFilter.value ? [toFilter.value] : []),
  ],
  set: (tokens) => {
    const of = (field: string) => tokens.filter((t) => t.field === field).map((t) => t.value);
    assignSet(moduleFilter, of('modulo'));
    assignSet(sourceFilter, of('container'));
    assignSet(agentFilter, of('agente'));
    assignSet(taskFilter, of('tarea'));
    assignSet(taskTitleFilter, of('titulo'));
    assignSet(projectFilter, of('proyecto'));
    assignSet(ruleFilter, of('regla'));
    assignSet(runFilter, of('run'));
    assignSet(extraFilter, of('extra'));
    // El nivel es uno solo: dos tokens serían dos niveles a la vez, que el
    // endpoint no soporta (`level` es un valor, no una lista). Gana el último.
    levelFilter.value = parseLevel(of('nivel').at(-1) ?? '');
    fromFilter.value = of('desde').at(-1) ?? '';
    toFilter.value = of('hasta').at(-1) ?? '';
    // El token ya es la confirmación explícita del operador: el debounce que
    // existía para no consultar en cada tecla acá no aporta nada, así que se
    // aplica de una.
    const msg = of('msg').at(-1) ?? '';
    searchInput.value = msg;
    searchApplied.value = msg;
  },
});

/** Prende o apaga un token desde afuera del input — hoy, los conteos del
 *  resumen. Escribe por el mismo `set` que el input, así que no hay un segundo
 *  camino que mantener sincronizado. */
function toggleToken(field: string, value: string): void {
  const has = filterTokens.value.some((t) => t.field === field && t.value === value);
  filterTokens.value = has
    ? filterTokens.value.filter((t) => !(t.field === field && t.value === value))
    : [...filterTokens.value, { field, value }];
}

function hasToken(field: string, value: string): boolean {
  return filterTokens.value.some((t) => t.field === field && t.value === value);
}

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
  if (agentFilter.value.size > 0) f.agentId = Array.from(agentFilter.value);
  if (taskFilter.value.size > 0) f.taskId = Array.from(taskFilter.value);
  if (taskTitleFilter.value.size > 0) f.task = Array.from(taskTitleFilter.value);
  if (projectFilter.value.size > 0) f.projectId = Array.from(projectFilter.value);
  if (ruleFilter.value.size > 0) f.ruleId = Array.from(ruleFilter.value);
  if (runFilter.value.size > 0) f.runId = Array.from(runFilter.value);
  if (extraFilter.value.size > 0) f.extra = Array.from(extraFilter.value);
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
    // Los valores de agente/tarea/proyecto/run salen de lo que las líneas
    // traen: no hay endpoint que liste su universo, y acumular es lo que evita
    // que filtrar por uno deje al resto sin sugerencias.
    const nextExtras = { ...discoveredExtras.value };
    let grew = false;
    for (const key of Object.keys(nextExtras)) {
      const set = new Set(nextExtras[key]);
      for (const e of data.entries) {
        const value = e.extras?.[key];
        if (typeof value === 'string' && value) set.add(value);
      }
      if (set.size !== nextExtras[key].size) {
        nextExtras[key] = set;
        grew = true;
      }
    }
    if (grew) discoveredExtras.value = nextExtras;
    // Universo de claves de extras vistas — alimenta el picker de "+
    // columna". No filtra por tipo de valor: una clave con un objeto (ej.
    // `err`) igual se puede agregar como columna, formatExtraValue la
    // serializa.
    const nextExtraKeys = new Set(discoveredExtraKeys.value);
    for (const e of data.entries) {
      for (const key of Object.keys(e.extras ?? {})) nextExtraKeys.add(key);
    }
    if (nextExtraKeys.size !== discoveredExtraKeys.value.size) {
      discoveredExtraKeys.value = nextExtraKeys;
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
  void load();
}

function loadMore() {
  offset.value += PAGE_LIMIT;
  void load();
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

function entryKey(entry: ServerLogEntry, index: number): string {
  return `${entry.time}-${index}`;
}

function toggleRow(id: string) {
  expandedId.value = expandedId.value === id ? null : id;
}

function copyJson(entry: ServerLogEntry) {
  void navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
}

// `extras.clearDedupe` es el curl que daemon.ts/container.ts arman al loguear
// un evento deduplicado o sin ninguna regla matcheada (ver DELETE
// /api/webhooks/dedupe/:eventId) — trae el id de la entrega ya embebido. Sólo
// falta pegarle el secreto: no lo copiamos automático porque el front no
// conoce IA_FLOW_WEBHOOK_SECRET (es un secreto write-only, igual que el resto
// de las credenciales de este proyecto).
function clearDedupeCurl(entry: ServerLogEntry): string | null {
  const value = entry.extras?.clearDedupe;
  return typeof value === 'string' ? value : null;
}
function copyClearDedupeCurl(entry: ServerLogEntry) {
  const curl = clearDedupeCurl(entry);
  if (curl) void navigator.clipboard.writeText(curl);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es');
}

// Compact time column: HH:MM:SS.mmm when the log is from today (typical
// debug session), or "DD MMM HH:MM:SS" when it's from a previous day.
// Keeps every row's leading column narrow + monospace-aligned. Month name
// uses the browser's locale so a US machine reads "Jan" and es-* reads "ene".
const monthAbbrFormatter = new Intl.DateTimeFormat('es', { month: 'short' });
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

const COLUMN_VALUE_TRUNCATE = 40;
/** Un valor de `extras` puede ser string, número, o un objeto (`err`) — se
 *  serializa igual que `extraAsText` del lado server, para que lo que se ve
 *  en la columna sea lo mismo contra lo que matchea `extra:<clave>:<patrón>`. */
function formatExtraValue(value: unknown): string {
  if (value === undefined || value === null) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > COLUMN_VALUE_TRUNCATE ? `${text.slice(0, COLUMN_VALUE_TRUNCATE)}…` : text;
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

// Refetch from scratch whenever a *server-side* filter changes. Se mira
// `searchApplied` y no `searchInput` porque es el que el servidor recibe; hoy se
// mueven juntos (el token los escribe a los dos), pero el que manda es éste.
watch(
  [
    levelFilter,
    moduleFilter,
    sourceFilter,
    agentFilter,
    taskFilter,
    taskTitleFilter,
    projectFilter,
    ruleFilter,
    runFilter,
    extraFilter,
    searchApplied,
    fromFilter,
    toFilter,
    columnSort,
  ],
  () => {
    resetAndLoad();
  },
);

onMounted(() => {
  void load();
  void loadAllModules();
  void loadAllSources();
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

    <FilterQueryInput
      v-model="filterTokens"
      :fields="filterFields"
      default-field="msg"
      testid="server-logs-filter"
      placeholder="Filtrar… un campo (nivel, modulo, msg…) o texto plano busca en el mensaje"
    />

    <div v-if="error" class="items-error">{{ error }}</div>

    <!-- El conteo ES el filtro: clickearlo prende el token `nivel:<x>`, el
         mismo que se escribe en el input. Un atajo, no un segundo camino. -->
    <div class="log-summary" aria-label="Resumen por nivel">
      <span class="log-summary__total">{{ total }} entradas</span>
      <button
        v-for="lvl in LEVEL_ORDER"
        :key="lvl"
        type="button"
        class="log-summary__count"
        :class="[
          `log-summary__count--${lvl}`,
          { 'log-summary__count--zero': levelCounts[lvl] === 0 },
        ]"
        :aria-pressed="hasToken('nivel', lvl)"
        :title="`Filtrar por nivel:${lvl}`"
        :data-testid="`server-logs-summary-${lvl}`"
        @click="toggleToken('nivel', lvl)"
      >{{ lvl }} <b>{{ levelCounts[lvl] }}</b></button>
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
        <span
          v-for="col in activeColumns"
          :key="col"
          class="log-extra-col-header"
          :title="col"
        >
          {{ columnLabel(col) }}
          <button
            type="button"
            class="log-col-remove"
            title="Quitar columna"
            @click.stop="removeColumn(col)"
          >×</button>
        </span>
        <div class="log-add-column">
          <button
            type="button"
            class="log-add-column-btn"
            title="Agregar columna"
            data-testid="server-logs-add-column"
            @click.stop="addColumnMenuOpen = !addColumnMenuOpen"
          >+</button>
          <div v-if="addColumnMenuOpen" class="log-add-column-menu" @click.stop>
            <p v-if="addableColumns().length === 0" class="log-add-column-empty">
              Sin campos nuevos para agregar todavía
            </p>
            <button
              v-for="key in addableColumns()"
              :key="key"
              type="button"
              class="log-add-column-item"
              @click="addColumn(key)"
            >{{ columnLabel(key) }}</button>
          </div>
        </div>
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
            data-kbd-item
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
            </span>
            <span
              v-for="col in activeColumns"
              :key="col"
              class="log-extra-col"
              :title="formatExtraValue(entry.extras?.[col])"
            >{{ formatExtraValue(entry.extras?.[col]) }}</span>
            <span class="log-chevron" aria-hidden="true">
              {{ expandedId === entryKey(entry, index) ? '▾' : '▸' }}
            </span>
          </button>

        <div v-if="expandedId === entryKey(entry, index)" class="log-detail">
          <div v-if="entry.extras" class="detail-fields">
            <div v-for="[key, value] in Object.entries(entry.extras ?? {})" :key="key" class="detail-field-row">
              <span class="detail-field-key">{{ key }}</span>
              <span class="detail-field-value">{{ formatExtraValue(value) }}</span>
              <div class="detail-field-menu">
                <button
                  type="button"
                  class="detail-field-dots"
                  title="Opciones del campo"
                  :data-testid="`server-logs-field-menu-${key}`"
                  @click.stop="toggleFieldMenu(fieldMenuId(entryKey(entry, index), key))"
                >⋮</button>
                <div
                  v-if="openFieldMenu === fieldMenuId(entryKey(entry, index), key)"
                  class="detail-field-menu-popover"
                  @click.stop
                >
                  <button type="button" class="detail-field-menu-item" @click="toggleColumn(key); closeMenus()">
                    {{ isColumnActive(key) ? 'Quitar columna' : 'Agregar columna' }}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div class="detail-header">
            <span class="detail-title">JSON completo</span>
            <div class="detail-actions">
              <button
                v-if="clearDedupeCurl(entry)"
                type="button"
                class="btn-copy"
                data-testid="server-logs-copy-clear-dedupe"
                :title="clearDedupeCurl(entry) ?? ''"
                @click="copyClearDedupeCurl(entry)"
              >
                Copiar curl (limpiar dedupe)
              </button>
              <button
                type="button"
                class="btn-copy"
                data-testid="server-logs-copy-json"
                @click="copyJson(entry)"
              >
                Copiar JSON
              </button>
            </div>
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
.log-summary__count {
  display: inline-flex;
  align-items: baseline;
  gap: 0.25rem;
  padding: 0.1rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.log-summary__count:hover { background: var(--panel-hi); }
.log-summary__count[aria-pressed='true'] { outline: 2px solid var(--fg); outline-offset: 1px; }
.log-summary__count b { font-weight: 700; }
.log-summary__count--trace { color: var(--fg-dim); }
.log-summary__count--debug { color: var(--info); }
.log-summary__count--info  { color: var(--accent); }
.log-summary__count--warn  { color: var(--warn); }
.log-summary__count--error { color: var(--danger); }
.log-summary__count--fatal { color: var(--danger); }
.log-summary__count--zero { opacity: 0.4; }

/* El wrapper es el contenedor con scroll: header y filas pueden ser más
   anchos que la pantalla (mensaje + columnas de extras agregadas) y en vez
   de recortarse en silencio contra el borde, aparece un scrollbar
   horizontal. `min-width: 100%` en header/fila es lo que hace que, sin
   columnas extra, sigan ocupando el ancho completo como antes. */
.log-list-wrapper { position: relative; overflow-x: auto; }
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
  width: max-content;
  min-width: 100%;
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
  /* Mismo motivo que .log-row: sin esto, `overflow: hidden` (acá sólo para
     redondear las esquinas y el rail de severidad) recortaría la fila un
     nivel más abajo del scroll horizontal del wrapper. */
  width: max-content;
  min-width: 100%;
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
  width: max-content;
  min-width: 100%;
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
.log-chevron { color: var(--fg-dim); font-size: 0.85rem; }

/* ─── Columnas de extras (header + celda) ────────────────────────────── */
.log-extra-col-header {
  flex-shrink: 0;
  min-width: 100px;
  max-width: 160px;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log-col-remove {
  background: none;
  border: none;
  padding: 0;
  color: var(--fg-dim);
  cursor: pointer;
  font-size: 0.9rem;
  line-height: 1;
}
.log-col-remove:hover { color: var(--danger); }
.log-extra-col {
  flex-shrink: 0;
  min-width: 100px;
  max-width: 160px;
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  color: var(--fg-mute);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log-add-column { position: relative; flex-shrink: 0; }
.log-add-column-btn {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--panel);
  border: 1px solid var(--border-hi);
  border-radius: 4px;
  color: var(--fg-mute);
  cursor: pointer;
  font-size: 0.85rem;
  line-height: 1;
  text-transform: none;
}
.log-add-column-btn:hover { color: var(--fg); background: var(--panel-hi); }
.log-add-column-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 5;
  min-width: 160px;
  max-height: 260px;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  padding: 0.25rem;
  text-transform: none;
  font-weight: 400;
  letter-spacing: normal;
}
.log-add-column-empty {
  margin: 0;
  padding: 0.4rem 0.5rem;
  color: var(--fg-dim);
  font-size: var(--fs-chrome);
}
.log-add-column-item {
  background: none;
  border: none;
  text-align: left;
  padding: 0.35rem 0.5rem;
  border-radius: 4px;
  color: var(--fg);
  font-size: var(--fs-body-sm);
  cursor: pointer;
}
.log-add-column-item:hover { background: var(--panel-hi); }

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
.detail-actions { display: flex; gap: 0.5rem; }

/* ─── "Campos" — lista de extras con el "…" (agregar/quitar columna) ───── */
.detail-fields {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.detail-field-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.3rem 0.6rem;
  font-size: var(--fs-body-sm);
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.detail-field-row:last-child { border-bottom: none; }
.detail-field-key {
  flex-shrink: 0;
  min-width: 110px;
  font-family: var(--font-mono);
  color: var(--info);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-field-value {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-field-menu { position: relative; flex-shrink: 0; }
.detail-field-dots {
  background: none;
  border: none;
  color: var(--fg-dim);
  cursor: pointer;
  padding: 0.1rem 0.35rem;
  font-size: 0.9rem;
  line-height: 1;
}
.detail-field-dots:hover { color: var(--fg); }
.detail-field-menu-popover {
  position: absolute;
  top: calc(100% + 2px);
  right: 0;
  z-index: 5;
  background: var(--panel);
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  padding: 0.25rem;
  white-space: nowrap;
}
.detail-field-menu-item {
  background: none;
  border: none;
  text-align: left;
  padding: 0.35rem 0.6rem;
  border-radius: 4px;
  color: var(--fg);
  font-size: var(--fs-body-sm);
  cursor: pointer;
  width: 100%;
}
.detail-field-menu-item:hover { background: var(--panel-hi); }
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
</style>
