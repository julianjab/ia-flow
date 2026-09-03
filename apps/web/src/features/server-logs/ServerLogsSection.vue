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
import JsonTreeNode from '@/ui/JsonTreeNode.vue';

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

// ─── Columnas — al estilo Datadog: "..." en un campo del detalle agrega/quita
// ese campo como columna de la tabla, con drag & drop para reordenar y +
// para agregar. Las CUATRO columnas base (Fecha/Nivel/Módulo/Mensaje) viven
// en el mismo array que las de `extras`: es lo que permite que también se
// puedan sacar y reordenar, no sólo las agregadas. Preferencia por-viewer:
// vive en localStorage, no en el server (dos pestañas de dos operadores
// pueden mirar columnas distintas del mismo log).
// `:v3` porque el FORMATO de los paths de extras cambió: antes una columna
// de extras se guardaba SIN el prefijo `extras.` (`agentId`), ahora lleva el
// path real dentro de `entry` (`extras.agentId`) — es lo que permite que el
// árbol JSON recursivo (`JsonTreeNode.vue`) y las columnas usen la MISMA
// noción de "path" sin un guard de colisión aparte para nombres que
// coinciden con una columna base. Con la clave vieja, un `["agentId"]` ya
// persistido no resolvería ningún valor (`getNestedValue(entry, 'agentId')`
// no es `entry.extras.agentId`). Bumpear la clave es más simple y más
// seguro que migrar: es una preferencia de UI por-viewer, perderla una vez
// no cuesta nada.
const COLUMNS_STORAGE_KEY = 'ia-flow:server-logs:columns:v3';
const BASE_COLUMNS = ['time', 'level', 'module', 'msg'] as const;
const BASE_COLUMN_SET = new Set<string>(BASE_COLUMNS);
function isBaseColumn(key: string): boolean {
  return BASE_COLUMN_SET.has(key);
}
// Nivel no va en el default — ya se ve como el color/rail de la fila
// (log-card--warn/error/fatal), así que la columna de texto es redundante
// hasta que alguien la quiera explícitamente. Sigue disponible en el picker
// de "+" (BASE_COLUMNS, arriba, tiene las cuatro).
const DEFAULT_ACTIVE_COLUMNS = ['time', 'module', 'msg'] as const;
// Sólo estas cuatro tienen soporte de sort en el server (ServerLogSortBy) —
// una columna de extras no es sorteable, no hay ORDER BY posible sobre un
// campo que puede ni existir en la línea.
function isSortableColumn(key: string): key is ServerLogSortBy {
  return key === 'time' || key === 'level' || key === 'module' || key === 'msg'
}
const BASE_COLUMN_LABELS: Record<string, string> = {
  time: 'Fecha',
  level: 'Nivel',
  module: 'Módulo',
  msg: 'Mensaje',
}
const EXTRA_COLUMN_LABELS: Record<string, string> = {
  agentId: 'Agente',
  taskId: 'Tarea',
  task: 'Título',
  projectId: 'Proyecto',
  ruleId: 'Regla',
  runId: 'Run',
  source: 'Contenedor',
};
function columnLabel(key: string): string {
  if (BASE_COLUMN_LABELS[key]) return BASE_COLUMN_LABELS[key];
  // Las columnas de extras guardan el path real (`extras.agentId`) — el
  // catálogo de labels bonitos sigue keyed por el nombre sin prefijo.
  const bare = key.startsWith('extras.') ? key.slice('extras.'.length) : key;
  return EXTRA_COLUMN_LABELS[bare] ?? bare;
}
// Ancho de cada columna en el grid — Mensaje es la única elástica (`1fr`);
// el resto tiene un ancho fijo para que header y filas queden SIEMPRE
// alineados columna por columna, sea cual sea el contenido de cada fila
// (con flexbox + `width:max-content` esto no se puede garantizar: cada fila
// es su propio contexto de layout, así que dos filas con un módulo de largo
// distinto terminaban con el mensaje arrancando en una posición distinta —
// el bug que motivó este cambio a grid).
const BASE_COLUMN_WIDTHS: Record<string, string> = {
  time: '118px',
  level: '70px',
  module: '160px',
  msg: 'minmax(240px, 1fr)',
};
const EXTRA_COLUMN_WIDTH = '140px';
function columnWidth(key: string): string {
  return BASE_COLUMN_WIDTHS[key] ?? EXTRA_COLUMN_WIDTH;
}
// Ancho MÍNIMO de cada columna, en px — el número puro detrás de columnWidth
// (msg usa el piso de su minmax, 240, no "1fr"). Ver rowMinWidthPx: por qué
// hace falta esto aparte del string CSS de arriba.
const COLUMN_MIN_PX: Record<string, number> = { time: 118, level: 70, module: 160, msg: 240 };
const EXTRA_COLUMN_MIN_PX = 140;
function columnMinPx(key: string): number {
  return COLUMN_MIN_PX[key] ?? EXTRA_COLUMN_MIN_PX;
}

// ─── Ancho de columna arrastrable — el usuario puede fijar un ancho propio
// desde el handle a la derecha de cada header. Una vez fijado, GANA sobre
// `columnWidth`/`columnMinPx` (incluida la elasticidad `1fr` de msg: al
// resizear, msg deja de crecer con el wrapper y queda en un ancho fijo,
// como cualquier otra columna — es lo que "arrastrar para cambiar el
// tamaño" implica).
const COLUMN_WIDTHS_STORAGE_KEY = 'ia-flow:server-logs:column-widths:v1';
const MIN_RESIZE_PX = 60;
function loadStoredColumnWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= MIN_RESIZE_PX) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
const columnWidths = ref<Record<string, number>>(loadStoredColumnWidths());
function persistColumnWidths(): void {
  try {
    localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(columnWidths.value));
  } catch {
    // Storage lleno o bloqueado — el resize se ve igual en esta sesión.
  }
}
function effectiveColumnWidth(key: string): string {
  const custom = columnWidths.value[key];
  return custom !== undefined ? `${custom}px` : columnWidth(key);
}
function effectiveColumnMinPx(key: string): number {
  return columnWidths.value[key] ?? columnMinPx(key);
}
// Columna que se está resizeando ahora mismo, y su geometría de arranque —
// `mousemove`/`mouseup` van en `document` (no en el handle) porque el
// cursor sale del handle apenas se mueve un poco.
const resizingColumn = ref<string | null>(null);
let resizeStartX = 0;
let resizeStartWidth = 0;
function startColumnResize(key: string, event: MouseEvent): void {
  resizingColumn.value = key;
  resizeStartX = event.clientX;
  // Ancho REAL renderizado, no el mínimo — así una columna `msg` que hoy
  // ocupa más que su piso de 240px (por el `1fr`) arranca el resize desde
  // donde se la ve, no desde un salto brusco al piso.
  const header = (event.currentTarget as HTMLElement).closest('.log-col-header');
  resizeStartWidth = header?.getBoundingClientRect().width ?? columnMinPx(key);
  document.addEventListener('mousemove', onColumnResizeMove);
  document.addEventListener('mouseup', stopColumnResize);
}
function onColumnResizeMove(event: MouseEvent): void {
  if (!resizingColumn.value) return;
  const next = Math.max(MIN_RESIZE_PX, Math.round(resizeStartWidth + (event.clientX - resizeStartX)));
  columnWidths.value = { ...columnWidths.value, [resizingColumn.value]: next };
}
function stopColumnResize(): void {
  if (!resizingColumn.value) return;
  resizingColumn.value = null;
  document.removeEventListener('mousemove', onColumnResizeMove);
  document.removeEventListener('mouseup', stopColumnResize);
  persistColumnWidths();
}
onUnmounted(() => {
  document.removeEventListener('mousemove', onColumnResizeMove);
  document.removeEventListener('mouseup', stopColumnResize);
});
function loadStoredColumns(): string[] {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [...DEFAULT_ACTIVE_COLUMNS];
    const valid = parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return valid.length > 0 ? valid : [...DEFAULT_ACTIVE_COLUMNS];
  } catch {
    return [...DEFAULT_ACTIVE_COLUMNS];
  }
}
const activeColumns = ref<string[]>(loadStoredColumns());
// El template de grid, compartido por el header y CADA fila — es lo que
// garantiza que las columnas se alineen: todos miran el mismo string. Dos
// pistas fijas al final —"+ columna" y el chevron— además de las N de
// `activeColumns`; la fila no tiene un "+", pero deja un placeholder vacío
// en esa pista (ver template) para que el chevron caiga en la MISMA
// posición que en el header por orden de aparición, no por casualidad.
const gridTemplateColumns = computed(
  () => `${activeColumns.value.map(effectiveColumnWidth).join(' ')} 28px 28px`,
);
// El `min-width` NUMÉRICO (px) del header/fila/card — es lo que reemplaza a
// `width: max-content`.
//
// Un grid con una pista `minmax(240px, 1fr)` no tiene un "max-content" chico:
// el spec dice que la contribución max-content de esa pista es el
// max-content de SU CONTENIDO — para un mensaje largo, básicamente el largo
// del texto sin cortar. Con `width: max-content` en el header/fila, cada
// fila terminaba tan ancha como su mensaje más largo, y ninguna quedaba
// nunca angosta: el `overflow: hidden; text-overflow: ellipsis` de
// `.log-cell--msg`/`.log-cell--extra` no se activaba jamás porque la caja
// siempre medía exactamente lo que el contenido necesitaba — el bug real
// detrás de "el contenido grande empuja la columna siguiente".
//
// Calculando el mínimo a mano (suma de los pisos de cada pista + gaps +
// padding) y usándolo como `min-width` con `width: 100%` en vez de
// `width: max-content`, el grid queda acotado al ancho del wrapper en el
// caso normal (así el ellipsis SÍ corta), y sólo crece — activando el
// scroll horizontal del wrapper — cuando ese mínimo de verdad no entra
// (muchas columnas agregadas), nunca por el LARGO del contenido de una
// celda en particular.
const GRID_GAP_PX = 12; // 0.75rem
const ROW_PADDING_PX = 24; // 0.75rem a cada lado (mismo padding en header y fila)
const rowMinWidth = computed(() => {
  const tracks = [...activeColumns.value.map(effectiveColumnMinPx), 28, 28];
  const tracksPx = tracks.reduce((sum, w) => sum + w, 0);
  const gapsPx = (tracks.length - 1) * GRID_GAP_PX;
  return `${tracksPx + gapsPx + ROW_PADDING_PX}px`;
});
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
/**
 * Nunca deja la tabla sin ninguna columna — sacar la última no tiene forma
 * de deshacerse salvo borrando el localStorage a mano. `toggleColumn` (el
 * menú "…" del árbol JSON del detalle, invocado con el PATH real del campo
 * — `time`, o `extras.scope.issueId`) delega en `removeColumn`/`addColumn`
 * para no duplicar ese guard.
 *
 * Ya no hace falta un guard anti-colisión con las columnas base: como cada
 * columna de extras arrastra el prefijo `extras.`, un `key` como `module`
 * SÓLO puede significar la columna base real — no hay forma de que un
 * `extras.module` se confunda con ella.
 */
function toggleColumn(key: string): void {
  if (isColumnActive(key)) {
    removeColumn(key);
    return;
  }
  addColumn(key);
}
function removeColumn(key: string): void {
  if (!isColumnActive(key) || activeColumns.value.length <= 1) return;
  activeColumns.value = activeColumns.value.filter((k) => k !== key);
  persistColumns();
}
// Todas las claves de `extras` vistas en CUALQUIER línea desde que se montó
// el panel — alimenta el picker de "+ columna" del header. Acumulador, igual
// que discoveredModules: nunca encoge, así que sacar un filtro no vacía las
// opciones. Sólo el nivel superior — para anidados (`err.message`) el picker
// ofrece el input de texto libre de abajo, enumerar todas las combinaciones
// posibles no escala.
const discoveredExtraKeys = ref<Set<string>>(new Set());
const addColumnMenuOpen = ref(false);
// El picker filtra por esto — un log real acumula decenas de claves de
// extras (toolCalls, toolErrors, toolUseId, truncated, usage, …) y sin
// buscador la lista es puro scroll. Se limpia cada vez que el menú se abre,
// no al cerrarse: así el próximo "+" arranca sin el filtro de la vez
// anterior en vez de sorprender con una lista vacía.
const columnPickerSearch = ref('');
function toggleAddColumnMenu(): void {
  addColumnMenuOpen.value = !addColumnMenuOpen.value;
  if (addColumnMenuOpen.value) columnPickerSearch.value = '';
}
function matchesPickerSearch(key: string): boolean {
  const q = columnPickerSearch.value.trim().toLowerCase();
  if (!q) return true;
  return key.toLowerCase().includes(q) || columnLabel(key).toLowerCase().includes(q);
}
function addableBaseColumns(): string[] {
  return BASE_COLUMNS.filter((k) => !isColumnActive(k) && matchesPickerSearch(k));
}
function addableExtraColumns(): string[] {
  return Array.from(discoveredExtraKeys.value)
    .filter((k) => !isColumnActive(k) && matchesPickerSearch(k))
    .sort((a, b) => columnLabel(a).localeCompare(columnLabel(b)));
}
function addColumn(key: string): void {
  if (isColumnActive(key)) return;
  activeColumns.value = [...activeColumns.value, key];
  persistColumns();
  addColumnMenuOpen.value = false;
}
// Camino anidado (`extras.err.message`) para el campo que no está en el
// picker — a diferencia de antes, el prefijo `extras.` ya NO es opcional:
// es el path real dentro de `entry` (mismo que usa el árbol JSON), así que
// se toma literal tal como se escribió.
const customColumnInput = ref('');
function addCustomColumn(): void {
  const key = customColumnInput.value.trim();
  customColumnInput.value = '';
  if (!key || isColumnActive(key)) return;
  activeColumns.value = [...activeColumns.value, key];
  persistColumns();
  addColumnMenuOpen.value = false;
}

// ─── Reordenar columnas por drag & drop — HTML5 drag nativo, sin librería.
// Un solo ref global (a lo sumo un drag en curso a la vez) — alcanza para
// Chrome/Safari, pero Firefox exige datos reales en `dataTransfer` para
// siquiera INICIAR el drag (sin `setData`, `dragstart` corre pero el resto
// de la secuencia — dragover/drop — nunca dispara), así que el ref solo no
// alcanza.
const draggedColumn = ref<string | null>(null);
// Qué columna está DEBAJO del cursor mientras se arrastra — sin esto no hay
// forma de ver dónde va a quedar hasta soltar. `dragover` dispara a
// repetición sobre el mismo elemento (no una vez); escribir el ref en cada
// tick es barato así que no hace falta debounce.
const dragOverColumn = ref<string | null>(null);
function onColumnDragStart(key: string, event: DragEvent): void {
  draggedColumn.value = key;
  event.dataTransfer?.setData('text/plain', key);
}
function onColumnDragEnd(): void {
  // Contracara de dragstart — corre SIEMPRE (drop exitoso, Esc, soltar fuera
  // de cualquier columna), así que es el único lugar confiable para apagar
  // el estado "atenuado" del origen. `onColumnDrop` limpia lo suyo aparte
  // porque a veces corre antes que este handler y a veces después, según el
  // navegador.
  draggedColumn.value = null;
  dragOverColumn.value = null;
}
function onColumnDrop(targetKey: string): void {
  const from = draggedColumn.value;
  dragOverColumn.value = null;
  if (!from || from === targetKey) return;
  const cols = [...activeColumns.value];
  const fromIdx = cols.indexOf(from);
  const toIdx = cols.indexOf(targetKey);
  if (fromIdx === -1 || toIdx === -1) return;
  cols.splice(fromIdx, 1);
  cols.splice(toIdx, 0, from);
  activeColumns.value = cols;
  persistColumns();
}

// ─── Valor de una columna, con soporte de camino anidado ───────────────────
// `col` es siempre un path real dentro de `entry` — una columna base es
// `time`/`level`/`module`/`msg` (un segmento) y cualquier extra arrastra el
// prefijo `extras.` (`extras.agentId`, `extras.scope.issueId`), así que una
// sola función resuelve las dos sin distinguir caso.
function getNestedValue(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, segment) => {
    // `Object.hasOwn`, no `in`: `in` recorre la cadena de prototipos, así que
    // un camino como `__proto__.x` devolvería objetos internos de JS en vez
    // de `undefined` — es un input de texto libre, no hay por qué confiar
    // en que nunca escriban esas claves.
    if (acc !== null && typeof acc === 'object' && Object.hasOwn(acc as object, segment)) {
      return (acc as Record<string, unknown>)[segment];
    }
    return undefined;
  }, obj);
}
function extraColumnValue(entry: ServerLogEntry, key: string): unknown {
  return getNestedValue(entry, key);
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
      for (const key of Object.keys(e.extras ?? {})) nextExtraKeys.add(`extras.${key}`);
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
      <div class="log-list-header" role="row" :style="{ gridTemplateColumns, minWidth: rowMinWidth }">
        <div
          v-for="col in activeColumns"
          :key="col"
          class="log-col-header"
          :class="{
            'log-col-header--base': isBaseColumn(col),
            'log-col-header--dragging': draggedColumn === col,
            'log-col-header--drag-over': dragOverColumn === col && draggedColumn !== col,
          }"
          draggable="true"
          :data-testid="`server-logs-col-header-${col}`"
          @dragstart="onColumnDragStart(col, $event)"
          @dragend="onColumnDragEnd"
          @dragover.prevent="dragOverColumn = col"
          @dragleave="dragOverColumn === col && (dragOverColumn = null)"
          @drop.prevent="onColumnDrop(col)"
        >
          <button
            v-if="isSortableColumn(col)"
            type="button"
            class="log-header-btn"
            :class="{ 'log-header-btn--active': columnSort.column === col }"
            :data-testid="`server-logs-sort-${col}`"
            @click="selectColumn(col)"
          >{{ columnLabel(col) }}{{ sortArrow(col) }}</button>
          <span v-else class="log-header-label" :title="col">{{ columnLabel(col) }}</span>
          <button
            type="button"
            class="log-col-remove"
            title="Quitar columna"
            @click.stop="removeColumn(col)"
          >×</button>
          <!-- Handle de resize — `mousedown.stop.prevent` para que el gesto
               no dispare el `dragstart` HTML5 del header entero (reordenar):
               `preventDefault` en el mousedown es lo que evita que el
               navegador arranque el drag nativo desde acá. -->
          <span
            class="log-col-resize"
            :class="{ 'log-col-resize--active': resizingColumn === col }"
            :data-testid="`server-logs-col-resize-${col}`"
            @mousedown.stop.prevent="startColumnResize(col, $event)"
            @click.stop
          ></span>
        </div>
        <div class="log-add-column">
          <button
            type="button"
            class="log-add-column-btn"
            title="Agregar columna"
            data-testid="server-logs-add-column"
            @click.stop="toggleAddColumnMenu"
          >+</button>
          <div v-if="addColumnMenuOpen" class="log-add-column-menu" @click.stop>
            <input
              v-model="columnPickerSearch"
              type="text"
              class="log-add-column-search"
              placeholder="Buscar campo…"
              data-testid="server-logs-add-column-search"
            />
            <p v-if="addableBaseColumns().length === 0 && addableExtraColumns().length === 0" class="log-add-column-empty">
              Sin campos que coincidan
            </p>
            <button
              v-for="key in addableBaseColumns()"
              :key="key"
              type="button"
              class="log-add-column-item"
              @click="addColumn(key)"
            >{{ columnLabel(key) }}</button>
            <hr v-if="addableBaseColumns().length > 0 && addableExtraColumns().length > 0" class="log-add-column-sep" />
            <button
              v-for="key in addableExtraColumns()"
              :key="key"
              type="button"
              class="log-add-column-item"
              @click="addColumn(key)"
            >{{ columnLabel(key) }}</button>
            <hr class="log-add-column-sep" />
            <form class="log-add-column-custom" @submit.prevent="addCustomColumn">
              <input
                v-model="customColumnInput"
                type="text"
                placeholder="extras.err.message"
                data-testid="server-logs-add-column-custom"
              />
              <button type="submit" class="log-add-column-custom-btn">Agregar</button>
            </form>
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
          :style="{ minWidth: rowMinWidth }"
        >
          <button
            type="button"
            class="log-row"
            :style="{ gridTemplateColumns, minWidth: rowMinWidth }"
            data-kbd-item
            :aria-expanded="expandedId === entryKey(entry, index)"
            @click="toggleRow(entryKey(entry, index))"
          >
            <span
              v-for="col in activeColumns"
              :key="col"
              class="log-cell"
            >
              <span v-if="col === 'time'" class="log-cell--time" :title="formatDate(entry.time)">{{ formatTimeCompact(entry.time) }}</span>
              <span
                v-else-if="col === 'level'"
                class="log-level"
                :style="{
                  background: levelColor(entry.level).bg,
                  color: levelColor(entry.level).fg,
                }"
              >{{ entry.level }}</span>
              <span v-else-if="col === 'module'" class="log-cell--module">{{ entry.module ?? '—' }}</span>
              <span v-else-if="col === 'msg'" class="log-cell--msg">{{ truncateMsg(entry.msg) }}</span>
              <span v-else class="log-cell--extra" :title="formatExtraValue(extraColumnValue(entry, col))">{{ formatExtraValue(extraColumnValue(entry, col)) }}</span>
            </span>
            <!-- Pista vacía: en el header acá va el botón "+ columna". Sin
                 esto, el chevron de abajo caería una pista antes que el del
                 header (el grid coloca por orden de aparición, no por
                 nombre de pista). -->
            <span class="log-row-spacer" aria-hidden="true"></span>
            <span class="log-chevron" aria-hidden="true">
              {{ expandedId === entryKey(entry, index) ? '▾' : '▸' }}
            </span>
          </button>

        <div v-if="expandedId === entryKey(entry, index)" class="log-detail">
          <div class="detail-header">
            <span class="detail-title">JSON</span>
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
          <!-- Una sola vista: árbol JSON de verdad (recursivo, ver
               JsonTreeNode.vue) con el "…" de agregar/quitar columna en cada
               campo hoja. Antes era una lista PLANA de paths con padding
               calculado — no podía mostrar qué campos son hermanos (todos
               los top-level de `extras` quedaban a la misma sangría que
               `time`/`level`/etc en vez de un nivel más adentro), lo que se
               veía como "indentación inconsistente" sin serlo realmente:
               era la falta de agrupación visual real. "Copiar JSON" sigue
               copiando el JSON.stringify real. -->
          <div class="detail-json">
            <JsonTreeNode
              :data="entry"
              path=""
              :depth="0"
              :is-column-active="isColumnActive"
              :toggle-column="toggleColumn"
              :open-field-menu="openFieldMenu"
              :field-menu-id="(path: string) => fieldMenuId(entryKey(entry, index), path)"
              :toggle-field-menu="toggleFieldMenu"
              :close-menus="closeMenus"
            />
          </div>
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
   anchos que la pantalla (mensaje + columnas agregadas) y en vez de
   recortarse en silencio contra el borde, aparece un scrollbar horizontal.
   `width: 100%` en header/fila/card es lo que hace que, con las columnas
   por default, sigan ocupando el ancho completo como antes — y crucialmente,
   que el `1fr` de Mensaje se ACOTE a ese 100% en el caso normal, así el
   `overflow: hidden; text-overflow: ellipsis` de las celdas se activa de
   verdad. El piso real ante muchas columnas es `min-width` — pero un
   NÚMERO calculado en JS (`rowMinWidth`, ver el script), no `max-content`:
   un grid con una pista `minmax(240px, 1fr)` no tiene un max-content
   chico (el spec lo define como el max-content de SU CONTENIDO, básicamente
   el largo del texto sin cortar), así que `width: max-content` hacía que
   cada fila creciera hasta su mensaje más largo — el ellipsis nunca se
   activaba, y esa fila "empujaba" todo lo de la derecha.
   Header y fila son CSS GRID, no flexbox — con `gridTemplateColumns`
   compartido (mismo string, ver el computed en el script) es la única forma
   de garantizar que la columna N del header caiga exactamente sobre la
   columna N de CADA fila sin importar el largo del contenido de esa fila.
   Con flexbox, cada fila es su propio contexto de layout: dos filas con un
   módulo de largo distinto terminaban con el mensaje arrancando en una
   posición distinta — el bug real que motivó el cambio a grid. */
.log-list-wrapper { position: relative; overflow-x: auto; }
.log-list-header {
  /* Sin reset global de `box-sizing: border-box` (sólo lo tienen
     input/textarea/select en theme.css), un `<div>` con `width:100%` +
     padding + border queda MÁS ANCHO que su 100% — el navegador suma el
     padding/border encima. `.log-row` es un `<button>`, que en el UA
     stylesheet de Chrome/Safari ya es border-box por default, así que no
     se notaba ahí; acá sí, y era justo el header sobresaliendo a la
     derecha de las filas (mismo ancho declarado, caja real distinta). */
  box-sizing: border-box;
  display: grid;
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
  width: 100%;
}
.log-col-header {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
  overflow: hidden;
  cursor: grab;
  /* El borde transparente reserva el espacio del indicador de drop — sin
     esto, el borde de --drag-over corriera el contenido 2px al aparecer. */
  border-left: 2px solid transparent;
  border-right: 2px solid transparent;
}
.log-col-header:active { cursor: grabbing; }
/* La columna que se está arrastrando — atenuada, para que quede claro CUÁL
   se está moviendo mientras el cursor está sobre otra. */
.log-col-header--dragging { opacity: 0.35; }
/* Dónde va a quedar si soltás ahora. Sólo el HEADER se resalta — antes se
   repetía en cada fila (ver el historial de .log-cell--drag-over), pero
   pintar la columna entera de punta a punta era demasiado ruido visual
   sobre datos reales; con el header alcanza para ver dónde cae el drop. */
.log-col-header--drag-over {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  border-left-color: var(--accent);
  border-right-color: var(--accent);
}
/* Handle de resize — franja angosta pegada al borde derecho del header,
   arrastrable con el mouse (no HTML5 drag: eso es reordenar). La línea
   separadora se ve SIEMPRE (tenue, `--border-hi`) para que quede claro que
   hay un borde arrastrable ahí sin tener que pasar el mouse encima; en
   hover/activo pasa al color de acento, más notorio. */
.log-col-resize {
  position: absolute;
  top: 0;
  right: -0.15rem;
  bottom: 0;
  width: 0.5rem;
  cursor: col-resize;
  z-index: 2;
}
.log-col-resize::after {
  content: '';
  position: absolute;
  top: 15%;
  bottom: 15%;
  left: 50%;
  width: 2px;
  transform: translateX(-50%);
  background: var(--border-hi);
  border-radius: 1px;
}
.log-col-header:hover .log-col-resize::after,
.log-col-resize--active::after {
  background: var(--accent);
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
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log-header-btn:hover { color: var(--fg); }
.log-header-btn--active { color: var(--fg); }
.log-header-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
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
  /* Mismo motivo que .log-list-header: `<li>` es content-box por default,
     y con `border: 1px` sumado a `width: 100%` quedaba 2px más ancho que
     `.log-row` (que sí es border-box, por ser `<button>`). */
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-top: none;
  background: var(--panel);
  overflow: hidden;
  /* Mismo motivo que .log-row: sin `width:100%` acá (con el `min-width`
     numérico llevando el piso real), `overflow: hidden` (acá sólo para
     redondear las esquinas y el rail de severidad) recortaría la fila un
     nivel más abajo cuando de verdad hace falta el scroll del wrapper. */
  width: 100%;
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
  /* Ya lo es por default (UA stylesheet de `<button>`) — explícito para no
     depender de ese detalle de navegador, mismo motivo que arriba. */
  box-sizing: border-box;
  display: grid;
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

.log-cell { min-width: 0; overflow: hidden; display: flex; align-items: center; }
/* El badge de nivel es el único centrado — todo lo demás arranca a la
   izquierda de su celda. */
.log-cell:has(.log-level) { justify-content: center; }
.log-cell--time {
  font-variant-numeric: tabular-nums;
  color: var(--fg-dim);
  font-size: var(--fs-chrome);
  font-family: var(--font-mono);
}
.log-level {
  font-size: var(--fs-chrome);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 600;
  text-transform: lowercase;
  text-align: center;
}
.log-cell--module {
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  color: var(--info);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log-cell--msg { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-cell--extra {
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  color: var(--fg-mute);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.log-row-spacer { min-width: 0; }
.log-chevron { color: var(--fg-dim); font-size: 0.85rem; }

/* ─── Header de columna: quitar + agregar (+) ────────────────────────── */
.log-col-remove {
  background: none;
  border: none;
  padding: 0;
  color: var(--fg-dim);
  cursor: pointer;
  font-size: 0.9rem;
  line-height: 1;
  flex-shrink: 0;
}
.log-col-remove:hover { color: var(--danger); }
.log-add-column { position: relative; }
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
  min-width: 200px;
  max-height: 320px;
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
.log-add-column-search {
  /* sticky, no el input normal del flujo: la lista de abajo scrollea (la
     lista de claves de extras de un log real es larga — toolCalls,
     toolErrors, toolUseId, truncated, usage, …) y el buscador tiene que
     seguir a la vista mientras se scrollea. */
  position: sticky;
  top: 0;
  z-index: 1;
  flex-shrink: 0;
  margin-bottom: 0.25rem;
  padding: 0.35rem 0.5rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg);
  font-size: var(--fs-body-sm);
  font-family: inherit;
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
.log-add-column-sep { border: none; border-top: 1px solid var(--border); margin: 0.25rem 0; }
.log-add-column-custom { display: flex; gap: 0.3rem; padding: 0.25rem; }
.log-add-column-custom input {
  flex: 1;
  min-width: 0;
  padding: 0.3rem 0.4rem;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg);
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
}
.log-add-column-custom-btn {
  flex-shrink: 0;
  padding: 0.3rem 0.5rem;
  background: var(--panel-alt);
  border: 1px solid var(--border-hi);
  border-radius: 4px;
  color: var(--fg-mute);
  font-size: var(--fs-body-sm);
  cursor: pointer;
}
.log-add-column-custom-btn:hover { color: var(--fg); background: var(--panel-hi); }

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

/* ─── El JSON, con el "…" (agregar/quitar columna) en cada campo hoja ────
   Árbol recursivo real — ver JsonTreeNode.vue, que se llama a sí mismo por
   cada valor-objeto y trae sus propios estilos de fila/gutter/popover. Este
   contenedor sólo aporta el marco (scroll, borde, tipografía mono). */
.detail-json {
  margin: 0;
  padding: 0.6rem 0.75rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--fg);
  max-height: 480px;
  overflow: auto;
}

.load-more { display: flex; justify-content: center; margin-top: 0.85rem; }
</style>
