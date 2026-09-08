
<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import axios from 'axios';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useServerEvents } from '@/composables/useServerEvents';
import { fetchAvailableAgents } from '@/features/projects/availableApi';
import { fetchProjectItems } from '@/features/projects/sourceApi';
import { useProjectsStore } from '@/features/projects/store';
import { fetchServerLogs, type ServerLogEntry } from '@/features/server-logs/api';
import { useToastStore } from '@/stores/toast';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import FilterQueryInput from '@/ui/FilterQueryInput.vue';
import JsonTreeNode from '@/ui/JsonTreeNode.vue';
import { type FilterFieldDef, type FilterToken, type FilterValue, isDateValue } from '@/ui/filter-query';
import {
  type AgentDefinition,
  ExecutionLogSchema,
  ServerLogEntrySchema,
  type ServerLogLevel,
  type TaskDisposition,
} from '@ia-flow/shared';
import RunningRunsPanel from '@/components/RunningRunsPanel.vue';
import {
  cancelExecution,
  type ExecutionLog,
  fetchExecutions,
  fetchExecutionSources,
  fetchExecutionStats,
} from './api';
import { formatRelative } from './relativeTime';
import BucketHeader from '@/components/BucketHeader.vue';
import KbdBar from '@/components/KbdBar.vue';
import HealthVerdict from './HealthVerdict.vue';
import { dispositionOfOutcome, verbForRun } from './verdict';
import { useDispositionOrder } from '@/composables/useDispositionOrder';
import { useIsMobile, useIsSplit } from '@/composables/useIsMobile';
import ListControlsBar from '@/components/ListControlsBar.vue';
import AgentHealthPage from './AgentHealthPage.vue';
import RunRow from './RunRow.vue';
import RunVerdict from './RunVerdict.vue';

const props = withDefaults(
  defineProps<{ scope?: 'project' | 'global' }>(),
  { scope: 'project' },
);
const isGlobal = computed(() => props.scope === 'global');

// The outcome filter mirrors the shared enum; toggled from the summary
// chip row instead of a dedicated select.
type OutcomeFilter = '' | 'success' | 'error' | 'cancelled' | 'truncated';

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
const toastStore = useToastStore();
const activeProjectId = computed(() => projectsStore.activeProjectId);
const allProjects = computed(() => projectsStore.projects);
const router = useRouter();
// `route` is only read in onMounted to pick up an optional `?runId=<id>`
// coming from the dashboard's execution click. Kept as a plain ref (no
// watcher) because we only want the initial landing to auto-expand — later
// navigations within the section shouldn't retrigger the drawer.
const route = useRoute();
// In the global tab (General → Ejecuciones) the operator opts into a
// subset of projects via chips. Empty = todos los proyectos. Ignored when
// scope='project' since ProjectDetailView already scopes to a single one.
const projectFilter = ref<Set<string>>(new Set());
function projectNameFor(id: string): string {
  return allProjects.value.find((p) => p.id === id)?.name ?? id;
}

function openRunInLogs(exec: ExecutionLog) {
  // Para una acción el `runId` no existe en ningún log: se manda la regla, que
  // es por lo que sus líneas se pueden encontrar.
  const query =
    isAction(exec) && exec.ruleId ? { ruleId: exec.ruleId } : { runId: exec.id };
  void router.push({ path: '/general/logs', query });
}

// Server-side filters — the watchers below refetch when any of these change.
// Multi-select Sets: empty = "todos"; any elements = filter to those values.
type OutcomeValue = Exclude<OutcomeFilter, ''>;
const agentFilter = ref<Set<string>>(new Set());
const providerFilter = ref<Set<string>>(new Set());
// Which process (IA_FLOW_INSTANCE_ID) ran the agent — empty means the main
// daemon plus every forwarding headless container. See
// SourceTaggingExecutionLogRepository.
const sourceFilter = ref<Set<string>>(new Set());
// Quién tenía el issue cuando el agente corrió (execution_logs.assignees,
// migración 057). Una fila matchea si el usuario está ENTRE sus assignees, así
// que el chip es por persona aunque la columna guarde una lista.
const assigneeFilter = ref<Set<string>>(new Set());
const outcomeFilter = ref<Set<OutcomeValue>>(new Set());
// Set only by drilling in from the health panel — there's no chip row for it.
// The classes are derived (see failure-taxonomy.ts), so the useful entry point
// is "show me the runs behind this number", not free browsing by class.
const failureClassFilter = ref<string>('');
// Client-side "pending" flag. 'pending' isn't part of OutcomeSchema — it
// stands for `outcome IS NULL` (an in-flight or orphaned run) — so el servidor
// no lo puede filtrar con su `outcome IN (...)`.
//
// Junto a otros outcomes es un OR, no un AND: `resultado:error` +
// `resultado:pending` es "lo que falló, más lo que todavía corre". Para eso, con
// pending activo NO se manda `outcome` al servidor y el conjunto entero se
// resuelve en cliente — mandarlo dejaría fuera de la página justamente las filas
// sin outcome, y la combinación devolvía SIEMPRE vacío. Con la fila de chips el
// gesto era raro; el input presenta los cinco valores como la misma dimensión,
// así que invita a hacerlo.
const pendingFilter = ref(false);
const fromFilter = ref('');
const toFilter = ref('');
// Server-side, no client-side como `tarea`: el sentido de filtrar por trace es
// "traeme TODO lo que produjo este delivery/ciclo de scan", y eso puede no
// estar en la página ya cargada — a diferencia de buscar dentro de lo que ya
// se ve, acá hace falta volver a pedirle al servidor con `?traceId=`.
const traceIdFilter = ref('');
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
// Providers seen in any loaded execution. Grow-only Set so applying a
// provider filter doesn't collapse the chip row.
const discoveredProviders = ref<Set<string>>(new Set());
const providers = computed<string[]>(() => {
  const s = new Set(discoveredProviders.value);
  for (const p of providerFilter.value) s.add(p);
  return Array.from(s).sort((a, b) => a.localeCompare(b));
});
// Full universe of sources ever recorded (GET /api/executions/sources),
// merged with whatever the current page/filter has surfaced — same
// "never collapses the chip row" idea as discoveredProviders.
const allSources = ref<string[]>([]);
async function loadAllSources() {
  try {
    allSources.value = await fetchExecutionSources();
  } catch {
    allSources.value = [];
  }
}
// Mismo patrón que providers/containers: no hay endpoint que liste "los
// usuarios del board", así que los chips salen de lo que las filas cargadas
// traen, más lo que ya esté filtrado (para que el chip activo no desaparezca
// cuando el filtro deja fuera a todos los demás).
// La regla que disparó la fila y qué corrió (`agent`, `script`, `http`, …).
// Mismo patrón que providers/assignees: no hay endpoint que liste el universo,
// así que salen de las filas cargadas más lo que ya esté filtrado.
const ruleFilter = ref<Set<string>>(new Set());
const kindFilter = ref<Set<string>>(new Set());
const discoveredRules = ref<Set<string>>(new Set());
const discoveredKinds = ref<Set<string>>(new Set());
const rules = computed<string[]>(() => {
  const s = new Set(discoveredRules.value);
  for (const r of ruleFilter.value) s.add(r);
  return Array.from(s).sort((a, b) => a.localeCompare(b));
});
const kinds = computed<string[]>(() => {
  // 'agent' siempre: es el kind de todo run, y es el que sirve para pedir "sólo
  // los runs" — el listado de siempre, sin las acciones.
  const s = new Set(['agent', ...discoveredKinds.value]);
  for (const k of kindFilter.value) s.add(k);
  return Array.from(s).sort((a, b) => a.localeCompare(b));
});
const discoveredAssignees = ref<Set<string>>(new Set());
const assignees = computed<string[]>(() => {
  const s = new Set(discoveredAssignees.value);
  for (const a of assigneeFilter.value) s.add(a);
  return Array.from(s).sort((a, b) => a.localeCompare(b));
});
const discoveredSources = ref<Set<string>>(new Set());
const sources = computed<string[]>(() => {
  const s = new Set(allSources.value);
  for (const src of discoveredSources.value) s.add(src);
  for (const src of sourceFilter.value) s.add(src);
  return Array.from(s).sort((a, b) => a.localeCompare(b));
});
const loading = ref(false);
const error = ref<string>('');
const expandedId = ref<string | null>(null);

/**
 * Sobre `--bp-split` el detalle deja de flotar y se vuelve la segunda columna
 * — lo mismo que Tareas.
 *
 * No es sólo estética: el drawer flotante tapa 60vw de la lista, así que
 * recorrer varios runs seguidos —que es LA forma de usar esta pantalla— era
 * abrir, leer, cerrar, buscar dónde estabas. Como columna, la lista queda
 * entera y el `↑`/`↓` del teclado sigue moviéndose con el detalle al lado.
 */
const { isSplit } = useIsSplit();
/** Bajo `--bp-shell` el detalle es una PANTALLA, no un panel: ocupa todo y se
 *  cierra con `←` (A3, A5 — y la banda 1 del turno 6). */
const { isMobile } = useIsMobile();

// Per-execution cache for the related-logs sub-panel. Keyed by exec.id so
// re-expanding a card doesn't refetch (unless the user hits "↻ recargar").
const relatedLogs = ref<Record<string, ServerLogEntry[]>>({});
const relatedLoading = ref<Record<string, boolean>>({});
const relatedError = ref<Record<string, string>>({});

// The execution log doesn't carry an issue URL directly, so we fetch the
// project's source items once and build a taskId → issueUrl map. This works
// across sources (GitHub Projects items where the taskId is an opaque node
// id, plain GitHub issues where it's a number, local files, etc.).
const issueUrlByTaskId = ref<Record<string, string>>({});
async function loadIssueUrlMap() {
  // Cross-project issueUrl lookup would need N fetches; skip in global tab.
  if (isGlobal.value) { issueUrlByTaskId.value = {}; return; }
  const pid = activeProjectId.value;
  if (!pid) { issueUrlByTaskId.value = {}; return; }
  try {
    const res = await fetchProjectItems(pid);
    const next: Record<string, string> = {};
    for (const item of res.items ?? []) {
      const url = item.meta?.issueUrl;
      if (typeof url === 'string' && url) next[item.id] = url;
    }
    issueUrlByTaskId.value = next;
  } catch {
    // Non-fatal — the title just stays plain text.
  }
}
function issueUrlFor(taskId: string): string | null {
  return issueUrlByTaskId.value[taskId] ?? null;
}

/**
 * `#1240` — la columna `run` de 5d.
 *
 * Sale del final de la URL del issue, y si no hay URL del id de la tarea cuando
 * ES un número. Un node id de Projects V2 (`PVTI_lADO…`) NO se dibuja: ocho
 * caracteres opacos en la columna más angosta no identifican nada, y la fila ya
 * lleva el título al lado. La columna vacía es la respuesta correcta cuando la
 * fuente no numera sus items.
 */
function issueLabelFor(taskId: string): string | null {
  const fromUrl = issueUrlFor(taskId)?.match(/\/(\d+)(?:[?#].*)?$/)?.[1];
  if (fromUrl) return `#${fromUrl}`;
  return /^\d+$/.test(taskId) ? `#${taskId}` : null;
}

const OUTCOME_ORDER: Array<'success' | 'error' | 'cancelled' | 'truncated' | 'pending'> = [
  'success', 'error', 'cancelled', 'truncated', 'pending',
];

// ─── Los filtros, como un solo input `campo:valor` ────────────────────────
//
// Los refs de arriba siguen siendo la fuente de verdad —los leen `buildFilters`,
// los watchers que refetchean y el sync con la URL—, y el input es una VISTA de
// ellos. Al revés (tokens como estado y refs derivados) habría obligado a
// reescribir todo eso para ganar lo mismo.
//
// Cada dimensión es una entrada de este array: es lo que reemplazó a un bloque
// de ~20 líneas de template por cada grupo de chips.
const FILTER_FIELDS_BASE: Array<{
  key: string;
  hint?: string;
  values?: () => FilterValue[];
  free?: boolean;
  validate?: (value: string) => boolean;
}> = [
  // `free` en todo lo que se DESCUBRE. Su lista no es un universo sino "lo que
  // vimos": los agentes salen de un fetch que puede fallar o llegar tarde, y
  // providers/containers/assignees de las filas ya cargadas. Con lista cerrada,
  // vacía = imposible de filtrar — que es exactamente lo que pasaba con
  // `agente:` mientras la lista no estuviera. Sugerir lo conocido y aceptar lo
  // que no: un valor que no existe devuelve cero filas, que es una respuesta
  // legible, mientras que un campo que no deja escribir no tiene arreglo.
  //
  // `resultado` sí es cerrado: es un enum que el servidor valida, así que un
  // valor inventado sería un 400 en vez de una lista vacía.
  { key: 'agente', hint: 'quién corrió', values: () => agents.value.map((a) => a.id), free: true },
  { key: 'proveedor', hint: 'dónde corrió', values: () => providers.value, free: true },
  { key: 'resultado', hint: 'cómo terminó', values: () => [...OUTCOME_ORDER] },
  { key: 'container', hint: 'qué proceso lo despachó', values: () => sources.value, free: true },
  { key: 'assignee', hint: 'quién tenía el issue', values: () => assignees.value, free: true },
  { key: 'regla', hint: 'qué regla lo disparó', values: () => rules.value, free: true },
  { key: 'tipo', hint: 'agente o qué acción', values: () => kinds.value, free: true },
  { key: 'fallo', hint: 'clase de error', free: true },
  { key: 'tarea', hint: 'título o id', free: true },
  { key: 'desde', hint: 'AAAA-MM-DD', free: true, validate: isDateValue },
  { key: 'hasta', hint: 'AAAA-MM-DD', free: true, validate: isDateValue },
  { key: 'traceId', hint: 'todo lo que produjo el mismo delivery/scan', free: true },
];

const filterFields = computed<FilterFieldDef[]>(() => {
  const defs = FILTER_FIELDS_BASE.map((f) => ({
    key: f.key,
    hint: f.hint,
    values: f.values?.(),
    free: f.free,
    validate: f.validate,
  }));
  // El proyecto sólo filtra en la pestaña global: en la de un proyecto la vista
  // ya está acotada a uno, y ofrecer el campo sugeriría que se puede salir.
  if (!isGlobal.value) return defs;
  return [
    // Se busca y se muestra por nombre, se filtra por id: el id de un proyecto
    // es opaco y nadie lo reconoce en una lista.
    {
      key: 'proyecto',
      hint: 'de qué board',
      values: allProjects.value.map((p) => ({ value: p.id, label: p.name })),
    },
    ...defs,
  ];
});

/** Escribe el Set sólo si CAMBIÓ. Un `new Set()` con el mismo contenido es otra
 *  identidad, y los watchers que refetchean miran identidad: sin esto, tocar
 *  cualquier token dispara una consulta por cada dimensión que no cambió. */
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

function assignSet<T>(target: { value: Set<T> }, values: T[]): void {
  const next = new Set(values);
  if (next.size === target.value.size && values.every((v) => target.value.has(v))) return;
  target.value = next;
}

function setTokens(field: string, values: string[]): FilterToken[] {
  return values.map((value) => ({ field, value }));
}

const filterTokens = computed<FilterToken[]>({
  get: () => [
    ...setTokens('proyecto', Array.from(projectFilter.value)),
    ...setTokens('agente', Array.from(agentFilter.value)),
    ...setTokens('proveedor', Array.from(providerFilter.value)),
    ...setTokens('resultado', [
      ...Array.from(outcomeFilter.value),
      ...(pendingFilter.value ? ['pending'] : []),
    ]),
    ...setTokens('container', Array.from(sourceFilter.value)),
    ...setTokens('assignee', Array.from(assigneeFilter.value)),
    ...setTokens('regla', Array.from(ruleFilter.value)),
    ...setTokens('tipo', Array.from(kindFilter.value)),
    ...setTokens('fallo', failureClassFilter.value ? [failureClassFilter.value] : []),
    ...setTokens('tarea', taskTextInput.value ? [taskTextInput.value] : []),
    ...setTokens('desde', fromFilter.value ? [fromFilter.value] : []),
    ...setTokens('hasta', toFilter.value ? [toFilter.value] : []),
    ...setTokens('traceId', traceIdFilter.value ? [traceIdFilter.value] : []),
  ],
  set: (tokens) => {
    const of = (field: string) => tokens.filter((t) => t.field === field).map((t) => t.value);
    assignSet(projectFilter, of('proyecto'));
    assignSet(agentFilter, of('agente'));
    assignSet(providerFilter, of('proveedor'));
    assignSet(sourceFilter, of('container'));
    assignSet(assigneeFilter, of('assignee'));
    assignSet(ruleFilter, of('regla'));
    assignSet(kindFilter, of('tipo'));
    const outcomes = of('resultado');
    // `pending` no es parte de OutcomeSchema —es `outcome IS NULL`— así que
    // sale del mismo campo pero vive en su propio flag, filtrado en cliente.
    pendingFilter.value = outcomes.includes('pending');
    assignSet(outcomeFilter, outcomes.filter((o): o is OutcomeValue => o !== 'pending'));
    // Los de un solo valor se quedan con el último: escribir `desde:` dos veces
    // es corregirse, no pedir un rango imposible.
    failureClassFilter.value = of('fallo').at(-1) ?? '';
    // El token ya es la confirmación explícita: se aplica de una, sin esperar
    // el debounce que existía para no filtrar en cada tecla.
    const taskText = of('tarea').at(-1) ?? '';
    taskTextInput.value = taskText;
    taskTextApplied.value = taskText.trim().toLowerCase();
    fromFilter.value = of('desde').at(-1) ?? '';
    toFilter.value = of('hasta').at(-1) ?? '';
    traceIdFilter.value = of('traceId').at(-1) ?? '';
  },
});

const filteredExecutions = computed<ExecutionLog[]>(() => {
  let result = executions.value;
  // Client-side "pending" filter: keep only rows where the server has not
  // yet recorded an outcome. Applied before the text filter so both narrow
  // the same base set.
  if (pendingFilter.value) {
    const withOutcome = outcomeFilter.value;
    result = result.filter(
      (e) =>
        e.outcome === null || (withOutcome.size > 0 && withOutcome.has(e.outcome as OutcomeValue)),
    );
  }
  const q = taskTextApplied.value;
  if (!q) return result;
  return result.filter((e) =>
    e.taskTitle.toLowerCase().includes(q) || e.taskId.toLowerCase().includes(q),
  );
});

// Client-side column sort over filteredExecutions. Server already returns
// most-recent-first; we let the user re-sort in-place without a refetch.
// `providerId` y `outcome` ya no están: el proveedor se fue al detalle (en una
// fila de 390px no entra, y es lo que menos se compara entre runs) y el outcome
// dejó de ser una columna — es el bucket que agrupa la fila y el glifo que la
// abre, así que ordenar por él sería reordenar dentro de un grupo por lo que ya
// define al grupo.
type ExecSortColumn = 'startedAt' | 'taskTitle' | 'agentId' | 'duration';
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
// Tick used to compute live elapsed time for still-open executions. Updated
// every second by the interval below, but only while at least one row is
// still in-flight — otherwise the ref sits idle.
const now = ref(Date.now());
function durationMs(exec: ExecutionLog): number {
  const start = new Date(exec.startedAt).getTime();
  const end = exec.finishedAt ? new Date(exec.finishedAt).getTime() : now.value;
  return end - start;
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
      case 'duration':  cmp = durationMs(a) - durationMs(b); break;
    }
    return cmp * dir;
  });
  return arr;
});

// Un disparo de regla es UNA fila, y sus acciones se abren.
//
// Desde la migración 065 una ejecución puede ser una acción (`script`, `http`,
// `emit`) y no sólo un run de agente, y las que corrieron por el MISMO evento
// comparten `(eventId, ruleId)`. Mostrarlas sueltas triplicaba la lista con el
// mismo título repetido: lo que el operador escanea es "qué le pasó a esta
// tarea", y eso es el disparo entero, no cada entrada del `do[]`.
//
// Por eso el disparo colapsa a una fila resumen —la regla, cuándo empezó,
// cuánto duró en total, cómo terminó— y las acciones cuelgan de ahí sólo si la
// abrís. La jerarquía real queda dicha sin costo visual: el padre es la REGLA,
// nunca la primera acción (anidar el run bajo el `script` que corrió antes leía
// como si el script lo hubiera lanzado, y son hermanas).
//
// Un disparo de una sola fila NO se colapsa: un resumen de un solo hijo son dos
// renglones para decir lo que se lee en uno. Igual que una fila sin `eventId`
// (un run manual, uno anterior a la migración), sale plana.
type FiringRow = {
  key: string;
  ruleId: string | null;
  eventType: string | null;
  projectId: string;
  taskId: string;
  taskTitle: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: ExecutionLog['outcome'];
  /** Alguna acción ANTERIOR a la última terminó peor que éxito. La fila ya
   *  muestra el resultado de la última acción — esto es sólo la señal de que
   *  no fue un camino limpio hasta ahí. */
  hadEarlierIssue: boolean;
  providerId: string;
  count: number;
  /** La única fila viva del disparo, si hay exactamente una: es a quién detiene
   *  el botón del resumen. Con dos corriendo no se adivina — hay que abrir. */
  running: ExecutionLog | null;
  children: ExecutionLog[];
};
/** Una fila del listado: o el resumen de un disparo, o una ejecución. */
type ExecRow = { key: string; firing?: FiringRow; exec?: ExecutionLog; nested: boolean };

/** Qué mostrar como resultado del disparo entero. Mientras algo sigue vivo el
 *  disparo está `pending` aunque una acción ya haya fallado: todavía no
 *  terminó. Ya cerrado, se muestra el resultado de la ÚLTIMA acción por
 *  `position` — es lo que efectivamente cerró el disparo — y si alguna acción
 *  anterior terminó peor que éxito eso se marca aparte (`hadEarlierIssue`) en
 *  vez de tapar el resultado final con el peor de todos. */
function firingOutcome(
  byPosition: ExecutionLog[],
): { outcome: ExecutionLog['outcome']; hadEarlierIssue: boolean } {
  if (byPosition.some((r) => !r.finishedAt)) return { outcome: null, hadEarlierIssue: false };
  const last = byPosition[byPosition.length - 1];
  const hadEarlierIssue = byPosition
    .slice(0, -1)
    .some((r) => (OUTCOME_RANK[r.outcome ?? 'pending'] ?? 99) > OUTCOME_RANK.success);
  return { outcome: last.outcome, hadEarlierIssue };
}

function toFiring(key: string, group: ExecutionLog[]): FiringRow {
  const byPosition = [...group].sort((a, b) => positionOf(a) - positionOf(b));
  const head = byPosition[0];
  // El disparo empezó cuando arrancó su primera acción y terminó cuando cerró
  // la última — no cuando lo hizo la fila que el orden del listado dejó arriba.
  const startedAt = group.reduce((min, r) => (r.startedAt < min ? r.startedAt : min), head.startedAt);
  const unfinished = group.filter((r) => !r.finishedAt);
  const finishedAt = unfinished.length
    ? null
    : group.reduce<string | null>((max, r) => (max && max > (r.finishedAt ?? '') ? max : r.finishedAt), null);
  // El proveedor del run de agente: es el dato que el operador busca acá, y un
  // `script` no tiene ninguno.
  const agentRow = byPosition.find((r) => (r.kind ?? 'agent') === 'agent');
  const { outcome, hadEarlierIssue } = firingOutcome(byPosition);
  return {
    key,
    ruleId: head.ruleId ?? null,
    eventType: head.eventType ?? null,
    projectId: head.projectId,
    taskId: head.taskId,
    taskTitle: head.taskTitle,
    startedAt,
    finishedAt,
    outcome,
    hadEarlierIssue,
    providerId: agentRow?.providerId ?? '',
    count: group.length,
    running: unfinished.length === 1 ? unfinished[0] : null,
    children: byPosition,
  };
}

/**
 * El disparo, dicho como un run.
 *
 * `ExecutionStatusLine` es el vocabulario de estado de TODA la app, y habla de
 * ejecuciones: darle el resumen del disparo con esta forma es lo que hace que
 * un grupo de acciones se lea igual que un run suelto, en vez de tener su
 * propio badge. Los campos que un disparo no tiene van en null — no se inventan.
 */
function firingAsExec(f: FiringRow): ExecutionLog {
  return {
    id: f.key,
    projectId: f.projectId,
    taskId: f.taskId,
    taskTitle: f.taskTitle,
    agentId: f.ruleId ?? '',
    providerId: f.providerId,
    startedAt: f.startedAt,
    finishedAt: f.finishedAt,
    outcome: f.outcome,
    errorMsg: null,
    stopReason: null,
  };
}

/** Los disparos abiertos. Se guardan por clave del disparo y no por fila: las
 *  filas se recrean en cada refetch, así que una key de fila cerraría lo que el
 *  operador dejó abierto cada vez que llega un WS. */
const expandedFirings = ref<Set<string>>(new Set());
function isFiringOpen(key: string): boolean {
  return expandedFirings.value.has(key);
}
function toggleFiring(key: string) {
  const next = new Set(expandedFirings.value);
  if (!next.delete(key)) next.add(key);
  expandedFirings.value = next;
}

const groupedExecutions = computed<ExecRow[]>(() => {
  const out: ExecRow[] = [];
  const seen = new Set<string>();
  for (const exec of sortedExecutions.value) {
    const key = exec.eventId ? `${exec.eventId}::${exec.ruleId ?? ''}` : null;
    if (!key) {
      out.push({ key: exec.id, exec, nested: false });
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const group = sortedExecutions.value.filter(
      (e) => e.eventId && `${e.eventId}::${e.ruleId ?? ''}` === key,
    );
    if (group.length === 1) {
      out.push({ key: group[0].id, exec: group[0], nested: false });
      continue;
    }
    const firing = toFiring(key, group);
    out.push({ key: `firing:${key}`, firing, nested: false });
    if (!isFiringOpen(key)) continue;
    // Adentro manda `position`: el orden REAL en que el `do[]` las ejecutó.
    for (const child of firing.children) out.push({ key: child.id, exec: child, nested: true });
  }
  return out;
});

/**
 * Las filas agrupadas por disposición — el MISMO orden que Tareas, Qué sigue y
 * Board (O6).
 *
 * Arriba lo que falló y nadie va a reintentar; después lo que corre; los
 * terminados en una línea plegada (O4). Es el cambio más grande de esta
 * pantalla: era cronológica pura, y nueve runs terminados dominaban el alto
 * mientras los dos que piden algo quedaban abajo.
 *
 * Una fila de "firing" (varias acciones de una regla) toma la disposición de la
 * PEOR de sus hijas: un grupo donde una acción falló pide atención aunque las
 * otras tres hayan salido bien, y mandarlo a `cerradas` lo escondería.
 */
const BUCKET_SEVERITY: Record<string, number> = { 'waiting-on-you': 0, moving: 1, closed: 2 };

const dispositionRows = computed(() =>
  groupedExecutions.value
    // Las hijas de un firing abierto no se agrupan aparte: viven dentro de su
    // grupo, y sacarlas a otro bucket rompería la relación que el grupo dibuja.
    .filter((row) => !row.nested)
    .map((row) => {
      const outcomes = row.firing
        ? row.firing.children.map((c) => c.outcome)
        : [row.exec?.outcome ?? null];
      const disposition = outcomes
        .map(dispositionOfOutcome)
        .sort((a, b) => BUCKET_SEVERITY[a] - BUCKET_SEVERITY[b])[0];
      return { id: row.key, disposition, row };
    }),
);

/**
 * `RunningRunsPanel` y el bucket `moving` NO son la misma cosa, aunque los dos
 * hablen de lo que está corriendo.
 *
 * Lo primero que pensé fue sacar el bucket, y el código me corrigió: el panel
 * **delega en la fila** (`openRunFromPanel` la abre y scrollea hasta ella), y
 * sacarla de la lista rompía dos cosas concretas — filtrar por
 * `resultado:pending` no mostraba nada, y el botón de abortar de la fila
 * quedaba inalcanzable.
 *
 * La división que sí es: el panel es **actuá ahora** —duración en vivo, un
 * botón para abortar, arriba de todo— y la lista es **el registro**, donde se
 * filtra y se abre el detalle. Que un run aparezca en los dos no es
 * duplicación: es el resumen y su fila.
 */
const {
  buckets: execBuckets,
  movedCount: execMoved,
  freeze: freezeExecOrder,
  freezeIfFirst: freezeExecIfFirst,
} = useDispositionOrder(dispositionRows);

// El orden se congela con la primera carga que traiga filas. Sin esto,
// `execMoved` nunca sube y el aviso de reorden no aparece jamás.
watch(dispositionRows, () => freezeExecIfFirst(), { immediate: true });

/**
 * Lo que el bucket `cerradas` dice sin desplegarlo: cuánto salió bien y hace
 * cuánto fue lo último. Es lo único que se necesita saber de la parte del día
 * que NO hay que mirar (O4) — si esos dos números están bien, no hay razón
 * para abrirlo.
 */
const closedMeta = computed<string | undefined>(() => {
  const closed = executions.value.filter((e) => e.outcome === 'success');
  const finished = executions.value.filter((e) => e.finishedAt);
  if (!finished.length) return undefined;
  const pct = Math.round((closed.length / finished.length) * 100);
  const last = closed
    .map((e) => e.finishedAt)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1);
  return last ? `${pct}% ok · última ${formatRelative(last)}` : `${pct}% ok`;
});


/**
 * El promedio de duración del agente del run abierto, para el aviso de
 * lentitud del veredicto (banda 2).
 *
 * Se pide sólo cuando el run está VIVO: es la única situación donde "¿esto se
 * colgó?" es una pregunta, y así abrir un run terminado no paga un request
 * extra. Se cachea por agente porque la ventana es la misma para todos.
 *
 * Si falla, el aviso no se dibuja (R13): un run lento sin comparación es
 * simplemente un run.
 */
const agentAvgMs = ref<Record<string, number | null>>({});
const STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
async function loadAgentAvg(exec: ExecutionLog): Promise<void> {
  if (exec.finishedAt || !exec.agentId) return;
  if (exec.agentId in agentAvgMs.value) return;
  // Se marca ANTES del await: dos aperturas seguidas del mismo run vivo
  // dispararían dos requests idénticos mientras el primero está en vuelo.
  agentAvgMs.value = { ...agentAvgMs.value, [exec.agentId]: null };
  try {
    const stats = await fetchExecutionStats({
      from: new Date(Date.now() - STATS_WINDOW_MS).toISOString(),
      ...(isGlobal.value || !activeProjectId.value ? {} : { projectId: activeProjectId.value }),
    });
    const agent = stats.agents.find((a) => a.agentId === exec.agentId);
    agentAvgMs.value = { ...agentAvgMs.value, [exec.agentId]: agent?.avgDurationMs ?? null };
  } catch {
    // Ya quedó en null arriba: sin comparación, sin aviso.
  }
}

/**
 * La meta completa del run — plegada.
 *
 * El detalle son cinco bandas (turno 6) y ninguna es "la tabla de campos": lo
 * que se mira al abrir un run es el veredicto, la causa y el log. El resto
 * —taskId, traceId, eventId, assignees, el JSON crudo— es material de
 * auditoría: se necesita de vez en cuando y no puede desaparecer, así que
 * queda a un click en vez de empujar al log fuera de la pantalla.
 */
const metaOpen = ref(false);

/**
 * Qué se puede hacer con el run abierto (banda 5).
 *
 * No es una lista de botones sino la respuesta a "¿existe la acción?": abortar
 * sólo mientras corre, `Resolver` sólo si quedó abortado, la tarea sólo si la
 * fuente tiene una URL. Con las tres vacías la barra no se dibuja — una banda
 * que no puede ofrecer nada se omite entera en vez de mostrar un botón muerto
 * (R13).
 */
const detailActions = computed<string[]>(() => {
  const e = selectedExec.value;
  if (!e) return [];
  const out: string[] = [];
  if (!e.finishedAt) out.push('cancel');
  if (verbForRun(e)?.href) out.push('verb');
  if (issueUrlFor(e.taskId)) out.push('issue');
  return out;
});

/** `cerradas` arranca plegado: es la parte del día que NO hay que mirar (O4). */
const closedOpen = ref(false);

/**
 * La lista final: los encabezados de bucket intercalados entre las filas.
 *
 * Plana y no anidada a propósito. La lista ya resuelve dos cosas —los grupos de
 * "firing" con sus hijas indentadas, y la navegación por teclado sobre un solo
 * `data-kbd-list`— y meterla dentro de un `<ul>` por bucket rompía las dos: las
 * hijas quedarían fuera de su grupo y el foco saltaría entre listas. Un
 * marcador en la misma secuencia deja todo eso intacto.
 */
/**
 * Cuántas filas del bucket `te espera` se dibujan antes del corte (turno 8).
 *
 * Con 45 esperando, la lista completa no es una decisión: es un archivo. Las
 * primeras cuatro son las que el orden puso arriba —lo que más desbloquea,
 * después lo que más lleva esperando— y el resto se resume en una línea que
 * dice CUÁNTAS son y qué tienen en común.
 */
const WAITING_HEAD = 4;

/**
 * El eje que comparte el resto de la cola: `34 son tool_failure`, o
 * `14 son de implementer`.
 *
 * La clase de fallo manda cuando existe; con los fallos sin clasificar el
 * único eje con dato es el agente, y decir "34 son sin clasificar" no es un
 * corte útil sino la misma frase que ya dijo la banda de salud.
 */
function commonAxis(execs: ExecutionLog[]): string | null {
  if (execs.length < 2) return null;
  const tally = (pick: (e: ExecutionLog) => string | null | undefined) => {
    const counts = new Map<string, number>();
    for (const e of execs) {
      const k = pick(e);
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  };
  // Un eje que cubre el 10% del resto no es lo que tienen en común: es ruido
  // con forma de dato. Debajo de un cuarto, la línea sólo dice cuántas son.
  const enough = ([, n]: [string, number]) => n >= Math.max(2, execs.length / 4);
  // `cancelled` y `unknown` quedan afuera: el primero repite el outcome que el
  // glifo ya dice, y el segundo es la NO-clasificación — decir "34 son sin
  // clasificar" repite la banda de salud en vez de cortar la cola.
  const byClass = tally((e) =>
    e.failureClass && e.failureClass !== 'unknown' && e.failureClass !== 'cancelled'
      ? e.failureClass
      : null,
  );
  if (byClass && enough(byClass)) return `${byClass[1]} son ${byClass[0]}`;
  const byAgent = tally((e) => e.agentId);
  if (byAgent && enough(byAgent)) return `${byAgent[1]} son de ${byAgent[0]}`;
  return null;
}

/** Prende el token del corte: `agente:implementer`, `fallo:tool_failure`. */
function applyAxisToken(token: string): void {
  const [field, ...rest] = token.split(':');
  toggleToken(field, rest.join(':'));
}

/** El bucket 1 arranca cortado; se despliega desde su propia línea. */
const waitingExpanded = ref(false);

type DisplayRow =
  | { kind: 'header'; key: string; disposition: TaskDisposition; count: number }
  | { kind: 'more'; key: string; hidden: number; axis: string | null; token: string | null }
  | ({ kind: 'row' } & ExecRow);

const displayRows = computed<DisplayRow[]>(() => {
  const out: DisplayRow[] = [];
  for (const bucket of execBuckets.value) {
    out.push({
      kind: 'header',
      key: `bucket:${bucket.disposition}`,
      disposition: bucket.disposition,
      count: bucket.rows.length,
    });
    if (bucket.disposition === 'closed' && !closedOpen.value) continue;
    // El corte del bucket 1: las primeras cuatro, y el resto en una línea.
    const cut =
      bucket.disposition === 'waiting-on-you' && !waitingExpanded.value
        ? bucket.rows.slice(0, WAITING_HEAD)
        : bucket.rows;
    const hidden = bucket.rows.length - cut.length;
    for (const entry of cut) {
      out.push({ kind: 'row', ...entry.row });
      // Las hijas de un firing abierto van pegadas a su grupo, dentro del
      // mismo bucket: son el detalle de esa fila, no filas sueltas.
      if (entry.row.firing && isFiringOpen(entry.row.firing.key)) {
        for (const child of entry.row.firing.children) {
          out.push({ kind: 'row', key: child.id, exec: child, nested: true });
        }
      }
    }
    if (hidden > 0) {
      const rest = bucket.rows
        .slice(WAITING_HEAD)
        .map((e) => e.row.exec ?? e.row.firing?.children[0])
        .filter((e): e is ExecutionLog => !!e);
      const axis = commonAxis(rest);
      out.push({
        kind: 'more',
        key: `more:${bucket.disposition}`,
        hidden,
        axis,
        token: axisToken(rest, axis),
      });
    }
  }
  return out;
});

/** El campo:valor que reproduce el corte. Se arma del MISMO conteo que el
 *  texto, así que "14 son de implementer" y el filtro no pueden divergir. */
function axisToken(execs: ExecutionLog[], axis: string | null): string | null {
  if (!axis) return null;
  const m = axis.match(/^\d+ son (?:de )?(.+)$/);
  if (!m) return null;
  const value = m[1];
  return execs.some((e) => e.agentId === value) ? `agente:${value}` : `fallo:${value}`;
}

/** El lugar de la fila dentro del `do[]` de su regla. Sin posición va al final
 *  y no al principio: un `?? 0` la empataría con la primera acción y decidiría
 *  el empate el sort del listado, no el orden en que las cosas pasaron. */
function positionOf(exec: ExecutionLog): number {
  return exec.position ?? Number.MAX_SAFE_INTEGER;
}

/** Qué corrió en esta fila, para la etiqueta. `agent` no se etiqueta: es el
 *  caso normal y ya se ve por su agente y su provider. */
/**
 * Qué mostrar en el detalle, según QUÉ se ejecutó.
 *
 * Un run de agente y una acción comparten tabla pero no comparten columnas: una
 * acción `script` no tiene provider, ni assignees, ni `stopReason`, ni sesión, y
 * dibujarlas vacías hace que el detalle mienta sobre lo que se sabe. Al revés,
 * la regla y el lugar en el `do[]` son lo ÚNICO que ubica a una acción y no
 * tenían dónde verse.
 *
 * Una fila sin valor no se dibuja: la lista de campos es una decisión de qué es
 * relevante, no un volcado de la fila — para eso está el JSON completo, que
 * sigue abajo y no esconde nada.
 */
type DetailRow = {
  label: string;
  value: string;
  pre?: boolean;
  title?: string;
  /** Cuando está, la fila se dibuja como link — salta al run que la produjo
   *  (mismo mecanismo que el `?runId=` de la URL: `toggleRow`). */
  jumpToRunId?: string;
  /** Cuando está, la fila se dibuja como link — filtra la lista (server-side)
   *  a todo lo que comparte este traceId, en vez de sólo saltar dentro de la
   *  página ya cargada como hace `jumpToRunId`. */
  filterByTraceId?: boolean;
};

function isAction(exec: ExecutionLog): boolean {
  return (exec.kind ?? 'agent') !== 'agent';
}

function detailRows(exec: ExecutionLog): DetailRow[] {
  const rows: DetailRow[] = [];
  const add = (label: string, value: string | null | undefined, extra?: Partial<DetailRow>) => {
    if (value) rows.push({ label, value, ...extra });
  };
  if (isAction(exec)) {
    add('tipo', exec.kind);
    // El recorder guarda el nombre de la acción acá — una inline no tiene.
    add('acción', exec.agentId);
    add('regla', exec.ruleId);
    add('evento', exec.eventType);
    if (exec.position !== null && exec.position !== undefined) {
      add('posición en el do[]', String(exec.position));
    }
    add('eventId', exec.eventId);
    add('traceId', exec.traceId, { filterByTraceId: true });
    // Un evento sin issue (un `slack.message`) no tiene tarea: la columna
    // guarda '' porque es NOT NULL, no porque haya una tarea vacía.
    add('taskId', exec.taskId);
    // `errorMsg` guarda DOS cosas según cómo terminó: el detalle que la acción
    // reportó, o el error. Etiquetarlo siempre como error haría leer un
    // `success` con "errorMsg: 200 OK".
    add(exec.outcome === 'error' ? 'error' : 'detalle', exec.errorMsg, { pre: true });
  } else {
    add('taskId', exec.taskId);
    add('agentId', exec.agentId);
    add('providerId', exec.providerId);
    add('source', exec.source);
    add('assignees', exec.assignees?.length ? exec.assignees.join(', ') : null);
    // De qué disparo vino, cuando vino de uno. Un run manual no tiene regla.
    add('regla', exec.ruleId);
    add('evento', exec.eventType);
    add('traceId', exec.traceId, { filterByTraceId: true });
    add('errorMsg', exec.errorMsg, { pre: true });
    add('stopReason', exec.stopReason);
    // De qué run retomó el checkpoint — distinto de una jerarquía de
    // sub-agente (eso lo cuenta el propio `parentId`, hoy sin fila acá): esto
    // es la MISMA task continuando una conversación cortada por un restart o
    // una pausa.
    if (exec.resumedFromRunId) {
      rows.push({
        label: 'reanudado de',
        value: exec.resumedFromRunId,
        title: 'Ir al run anterior',
        jumpToRunId: exec.resumedFromRunId,
      });
    }
  }
  rows.push({
    label: 'startedAt',
    value: formatDate(exec.startedAt),
    title: exec.startedAt,
  });
  rows.push({
    label: 'finishedAt',
    value: exec.finishedAt ? formatDate(exec.finishedAt) : '—',
    title: exec.finishedAt ?? '',
  });
  return rows;
}

function kindLabel(exec: ExecutionLog): string | null {
  const kind = exec.kind ?? 'agent';
  return kind === 'agent' ? null : kind;
}

// Outcome counts across the loaded page — powers the summary row.
const outcomeCounts = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = { success: 0, error: 0, cancelled: 0, truncated: 0, pending: 0 };
  for (const e of executions.value) counts[e.outcome ?? 'pending']++;
  return counts;
});

async function loadAgents() {
  // Agent chips are per-project. In the global tab we skip them — the
  // available-agents endpoint is scoped to a project and merging across
  // projects would just clutter the filter row.
  if (isGlobal.value) { agents.value = []; return; }
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
  if (!isGlobal.value && !pid) {
    executions.value = [];
    error.value = 'Selecciona un proyecto primero.';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    executions.value = await fetchExecutions({
      ...(isGlobal.value
        ? projectFilter.value.size > 0
          ? { projectId: Array.from(projectFilter.value) }
          : {}
        : { projectId: pid as string }),
      ...(agentFilter.value.size > 0 ? { agentId: Array.from(agentFilter.value) } : {}),
      ...(providerFilter.value.size > 0
        ? { providerId: Array.from(providerFilter.value) }
        : {}),
      // Con `pending` activo el filtro de outcome se resuelve entero en
      // cliente: ver `filteredExecutions`.
      ...(outcomeFilter.value.size > 0 && !pendingFilter.value
        ? { outcome: Array.from(outcomeFilter.value) }
        : {}),
      ...(sourceFilter.value.size > 0 ? { source: Array.from(sourceFilter.value) } : {}),
      ...(assigneeFilter.value.size > 0 ? { assignee: Array.from(assigneeFilter.value) } : {}),
      ...(ruleFilter.value.size > 0 ? { ruleId: Array.from(ruleFilter.value) } : {}),
      ...(kindFilter.value.size > 0 ? { kind: Array.from(kindFilter.value) } : {}),
      ...(failureClassFilter.value
        ? { failureClass: failureClassFilter.value as never }
        : {}),
      ...(fromFilter.value ? { from: fromFilter.value } : {}),
      ...(toFilter.value ? { to: toFilter.value } : {}),
      ...(traceIdFilter.value ? { traceId: traceIdFilter.value } : {}),
      limit: limit.value,
    });
    // Accumulate discovered providers so chips remain visible after filtering.
    const nextDiscovered = new Set(discoveredProviders.value);
    for (const e of executions.value) if (e.providerId) nextDiscovered.add(e.providerId);
    if (nextDiscovered.size !== discoveredProviders.value.size) {
      discoveredProviders.value = nextDiscovered;
    }
    const nextRules = new Set(discoveredRules.value);
    for (const e of executions.value) if (e.ruleId) nextRules.add(e.ruleId);
    if (nextRules.size !== discoveredRules.value.size) discoveredRules.value = nextRules;
    const nextKinds = new Set(discoveredKinds.value);
    for (const e of executions.value) if (e.kind) nextKinds.add(e.kind);
    if (nextKinds.size !== discoveredKinds.value.size) discoveredKinds.value = nextKinds;
    const nextDiscoveredAssignees = new Set(discoveredAssignees.value);
    for (const e of executions.value) for (const a of e.assignees ?? []) nextDiscoveredAssignees.add(a);
    if (nextDiscoveredAssignees.size !== discoveredAssignees.value.size) {
      discoveredAssignees.value = nextDiscoveredAssignees;
    }
    const nextDiscoveredSources = new Set(discoveredSources.value);
    for (const e of executions.value) if (e.source) nextDiscoveredSources.add(e.source);
    if (nextDiscoveredSources.size !== discoveredSources.value.size) {
      discoveredSources.value = nextDiscoveredSources;
    }
  } catch (e) {
    // Axios throws Error subclasses with a descriptive `.message`; surface
    // that in the banner instead of console.error (see CLAUDE.md).
    error.value = extractErrorMessage(e);
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
    //
    // Una ACCIÓN no tiene `runId`: no es un run del agente y su id lo arma el
    // recorder (`evento:regla:posición`), que no aparece en ninguna línea. Lo
    // que sus handlers sí loguean es la REGLA, así que se correlaciona por ahí
    // dentro de la ventana de la acción — que dura milisegundos, así que no
    // arrastra las líneas de otro disparo de la misma regla.
    const forThisRun = entries.filter((e) => {
      const extras = e.extras;
      if (!extras) return false;
      if (isAction(exec)) return Boolean(exec.ruleId) && extras.ruleId === exec.ruleId;
      if (extras.runId === exec.id) return true;
      if (!extras.runId && extras.taskId === exec.taskId) return true;
      return false;
    });
    relatedLogs.value = { ...relatedLogs.value, [exec.id]: forThisRun };
    fetchedRunIds.value = new Set([...fetchedRunIds.value, exec.id]);
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
  const nextFetched = new Set(fetchedRunIds.value);
  nextFetched.delete(exec.id);
  fetchedRunIds.value = nextFetched;
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

function toolUseIdFromExtras(entry: ServerLogEntry): string | null {
  const id = entry.extras?.toolUseId;
  return typeof id === 'string' ? id : null;
}

// A related-logs row is either a plain log entry (`other`) or a merged
// tool-call/tool-result pair matched by `toolUseId`. Pairing lets the drawer
// show request + response as one card instead of two separate rows.
type RelatedItem =
  | { kind: 'other'; key: string; entry: ServerLogEntry }
  | { kind: 'tool'; key: string; call: ServerLogEntry | null; result: ServerLogEntry | null };

function groupRelatedLogs(entries: ServerLogEntry[], execId: string): RelatedItem[] {
  const items: RelatedItem[] = [];
  const pending = new Map<string, Extract<RelatedItem, { kind: 'tool' }>>();
  let seq = 0;

  for (const entry of entries) {
    const ev = eventFromExtras(entry);
    const id = toolUseIdFromExtras(entry);

    if ((ev === 'tool.call' || ev === 'tool.result') && id) {
      const existing = pending.get(id);
      if (existing) {
        if (ev === 'tool.call') existing.call = entry;
        else existing.result = entry;
        // Keep in the map so a stray duplicate would still land here, but
        // once both halves are set we won't overwrite them accidentally.
        continue;
      }
      const group: Extract<RelatedItem, { kind: 'tool' }> = {
        kind: 'tool',
        key: `${execId}-t-${id}`,
        call: ev === 'tool.call' ? entry : null,
        result: ev === 'tool.result' ? entry : null,
      };
      pending.set(id, group);
      items.push(group);
      continue;
    }

    // Non-tool events (or pre-migration entries without toolUseId) pass
    // through as their own row.
    items.push({ kind: 'other', key: `${execId}-o-${seq++}-${entry.time}`, entry });
  }

  return items;
}

const pairedRelatedLogs = computed<Record<string, RelatedItem[]>>(() => {
  const out: Record<string, RelatedItem[]> = {};
  for (const [execId, entries] of Object.entries(relatedLogs.value)) {
    out[execId] = groupRelatedLogs(entries, execId);
  }
  return out;
});

function headerEntryFor(item: Extract<RelatedItem, { kind: 'tool' }>): ServerLogEntry | null {
  return item.call ?? item.result;
}

// ─── Autoscroll ───────────────────────────────────────────────────────────
// The drawer body is the actual scroll container (the ul itself doesn't
// overflow), so we pin *its* scrollTop to the bottom as new entries stream
// in — unless the user scrolled up to read something. Threshold of 40px
// keeps small rendering bounces from flipping the flag.
const drawerBodyEl = ref<HTMLDivElement | null>(null);
const autoScroll = ref(true);
const AUTOSCROLL_STICK_THRESHOLD_PX = 40;

function onDrawerScroll() {
  const el = drawerBodyEl.value;
  if (!el) return;
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  autoScroll.value = distFromBottom <= AUTOSCROLL_STICK_THRESHOLD_PX;
}
function scrollRelatedToBottom() {
  const el = drawerBodyEl.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

// ─── Row expansion ────────────────────────────────────────────────────────
// Tracks runIds that have been reconciled with `daemon.log` at least once.
// Live mode primes an empty buffer for every new in-flight run so log:entry
// events can stream in immediately, but that prime isn't the same as "the
// user has seen the historical entries yet" — hence this separate set.
const fetchedRunIds = ref<Set<string>>(new Set());
// Per-execution pause. When present the log:entry handler drops events for
// that runId so the reader can inspect a snapshot without new rows shifting
// underneath. Resuming refetches from `daemon.log` to catch up on what was
// missed while paused.
const pausedRunIds = ref<Set<string>>(new Set());

function toggleRow(id: string) {
  const opening = expandedId.value !== id;
  expandedId.value = opening ? id : null;
  if (opening) {
    const exec = executions.value.find((e) => e.id === id);
    // On first open, hit the file to backfill anything that landed before
    // the drawer existed. Subsequent opens reuse the in-memory buffer,
    // which live mode keeps growing via WS.
    if (exec && !fetchedRunIds.value.has(exec.id)) {
      void loadRelatedLogs(exec);
    }
    // El promedio del agente, sólo si el run está vivo (ver `loadAgentAvg`).
    if (exec) void loadAgentAvg(exec);
    // Reset autoscroll so the newly-opened drawer starts pinned to bottom.
    autoScroll.value = true;
  }
}

function isPaused(runId: string): boolean {
  return pausedRunIds.value.has(runId);
}
function togglePause(exec: ExecutionLog) {
  const next = new Set(pausedRunIds.value);
  if (next.has(exec.id)) {
    next.delete(exec.id);
    pausedRunIds.value = next;
    // Resuming: refetch so any events dropped while paused are visible.
    void loadRelatedLogs(exec);
  } else {
    next.add(exec.id);
    pausedRunIds.value = next;
  }
}

// Right-side drawer state derived from expandedId. selectedExec === null
// means the drawer is closed.
const selectedExec = computed(() =>
  expandedId.value ? (executions.value.find((e) => e.id === expandedId.value) ?? null) : null,
);
function closeDetail() {
  expandedId.value = null;
}

// Salta al detalle de otro run (hoy sólo lo usa `resumedFromRunId`). Si ese
// run no está en la página cargada, `selectedExec` da null y el drawer no
// tiene qué mostrar — se avisa en vez de abrir un panel vacío.
function jumpToRun(runId: string) {
  if (!executions.value.some((e) => e.id === runId)) {
    toastStore.error(`El run ${runId} no está en esta página — ajustá el filtro o cargá más`);
    return;
  }
  expandedId.value = runId;
  const exec = executions.value.find((e) => e.id === runId);
  if (exec && !fetchedRunIds.value.has(exec.id)) void loadRelatedLogs(exec);
  autoScroll.value = true;
}

// A diferencia de `jumpToRun`, esto SÍ vuelve a pedirle al servidor
// (`?traceId=`): lo que un trace agrupa puede no estar en la página ya
// cargada. Cierra el drawer porque el run actual puede no sobrevivir al
// refiltrado (ver `filteredExecutions`).
function applyTraceIdFilter(traceId: string): void {
  closeDetail();
  traceIdFilter.value = traceId;
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && expandedId.value !== null) closeDetail();
}

function loadMore() {
  limit.value += LIMIT_STEP;
  // limit is a server-side filter; the watcher below will fire load().
}

// ─── Cancel execution ──────────────────────────────────────────────────────
interface PendingConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
}
const pendingConfirm = ref<PendingConfirm | null>(null);
function askConfirm(c: PendingConfirm) { pendingConfirm.value = c; }
async function runConfirm() {
  const c = pendingConfirm.value;
  if (!c) return;
  pendingConfirm.value = null;
  await c.onConfirm();
}
function cancelConfirm() { pendingConfirm.value = null; }

const cancellingIds = ref<Set<string>>(new Set());
function isCancelling(id: string): boolean {
  return cancellingIds.value.has(id);
}

function cancelErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string; message?: string } | undefined;
    return data?.error ?? data?.message ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function applyExecutionUpdate(exec: ExecutionLog) {
  executions.value = executions.value.map((e) => (e.id === exec.id ? exec : e));
}

async function doCancel(exec: ExecutionLog) {
  cancellingIds.value = new Set([...cancellingIds.value, exec.id]);
  try {
    const res = await cancelExecution(exec.id);
    applyExecutionUpdate(res.execution);
    // `alreadyFinished` is a valid race (the run closed itself right before
    // the click landed) — not an error, so no toast either way.
    if (res.cancelRequested) {
      // Advisory only — this daemon has no safe way to reach into the
      // container that owns the run (see routes/executions.ts), so it just
      // marked the row. The run itself keeps going.
      toastStore.success(
        `Se marcó como "cancelación solicitada". La ejecución sigue corriendo en "${res.execution.source}" — deténla desde ahí.`,
      );
    } else if (!res.alreadyFinished) {
      toastStore.success('Ejecución detenida');
    }
  } catch (err) {
    toastStore.error(`No se pudo detener la ejecución: ${cancelErrorMessage(err)}`);
  } finally {
    const next = new Set(cancellingIds.value);
    next.delete(exec.id);
    cancellingIds.value = next;
  }
}

/** El panel de "en vuelo" no duplica el detalle: abre el de la lista de abajo,
 *  que ya tiene el tail de logs, los hook events y el traceId. */
function openRunFromPanel(runId: string) {
  // El run puede no estar en la página cargada (filtros, paginado): abrirlo
  // igual es no-op, así que se scrollea sólo si la fila existe.
  if (expandedId.value !== runId) toggleRow(runId);
  document.querySelector(`[data-run-id="${runId}"]`)?.scrollIntoView({ block: 'center' });
}

function confirmCancelExecution(exec: ExecutionLog) {
  askConfirm({
    title: 'Detener ejecución',
    message: `¿Detener la ejecución de '${exec.taskTitle}'? Esta acción no se puede deshacer.`,
    confirmLabel: 'Detener',
    onConfirm: () => doCancel(exec),
  });
}

// Copy the full ExecutionLog JSON to the clipboard. `navigator.clipboard`
// needs a secure context (HTTPS or localhost), which matches our dev setup.
function copyJson(exec: ExecutionLog) {
  void navigator.clipboard.writeText(JSON.stringify(exec, null, 2));
}

/** El error, copiable entero — lo pide la banda de causa (turno 6). Avisa,
 *  porque copiar no deja rastro visible y sin toast no se sabe si funcionó. */
function copyError(text: string) {
  if (!text) return;
  void navigator.clipboard.writeText(text);
  toastStore.success('Error copiado al portapapeles');
}

// Formatters — kept as plain functions so the template stays declarative.
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es');
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('es', { hour12: false });
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : now.value;
  if (Number.isNaN(start) || Number.isNaN(end)) return '—';
  const ms = end - start;
  if (ms < 0) return '—';
  const suffix = finishedAt ? '' : '…';
  if (ms < 1000) return `${ms} ms${suffix}`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s${suffix}`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remSec}s${suffix}`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m${suffix}`;
}

function outcomeColor(outcome: ExecutionLog['outcome']): { bg: string; fg: string } {
  switch (outcome) {
    case 'success':   return { bg: 'var(--accent)', fg: 'var(--panel)' };
    case 'error':     return { bg: 'var(--danger)', fg: 'var(--panel)' };
    case 'cancelled': return { bg: 'var(--fg-dim)', fg: 'var(--panel)' };
    case 'truncated': return { bg: 'var(--warn)', fg: 'var(--panel)' };
    default:          return { bg: 'var(--border)', fg: 'var(--fg-mute)' };
  }
}

function outcomeLabel(outcome: ExecutionLog['outcome']): string {
  return outcome ?? 'pending';
}

// Same palette used by ServerLogsSection — kept in sync so a log's level
// looks identical whether it's rendered in the Logs tab or the exec detail.
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

const REL_MSG_TRUNCATE = 140;
function truncateMsg(msg: string): string {
  return msg.length > REL_MSG_TRUNCATE ? `${msg.slice(0, REL_MSG_TRUNCATE)}…` : msg;
}

// Autoscroll watcher: whenever the visible drawer's related-logs array grows
// and the reader hasn't scrolled up, pin the list to the bottom on next tick
// so the newest entry is in view.
watch(
  () => {
    const exec = selectedExec.value;
    if (!exec) return 0;
    return relatedLogs.value[exec.id]?.length ?? 0;
  },
  async () => {
    if (!autoScroll.value) return;
    await nextTick();
    scrollRelatedToBottom();
  },
);

// Live-elapsed ticker: 1Hz interval, only alive while ≥1 execution is still
// open. Avoids a permanent timer on a page that's usually all-finished rows.
const hasOpenExecutions = computed(() => executions.value.some((e) => !e.finishedAt));
let nowTimer: ReturnType<typeof setInterval> | null = null;
watch(
  hasOpenExecutions,
  (has) => {
    if (has && nowTimer === null) {
      now.value = Date.now();
      nowTimer = setInterval(() => { now.value = Date.now(); }, 1000);
    } else if (!has && nowTimer !== null) {
      clearInterval(nowTimer);
      nowTimer = null;
    }
  },
  { immediate: true },
);

// ─── Live mode ─────────────────────────────────────────────────────────────
// Subscribes to the shared server WS and merges execution:* / log:entry
// events into local state so the list, drawer, and per-run tool cards
// refresh without a manual reload. Defaults on; user can disable if the
// stream ever gets in the way.
const liveMode = ref(true);
const { connected: liveConnected } = useServerEvents((msg) => {
  if (!liveMode.value) return;

  if (msg.type === 'execution:started' || msg.type === 'execution:updated') {
    const parsed = ExecutionLogSchema.safeParse((msg as { log: unknown }).log);
    if (!parsed.success) return;
    const log = parsed.data;
    // Scope live events. In project mode: only the active project. In global
    // mode: respect the projectFilter chip set (empty = todos).
    if (isGlobal.value) {
      if (projectFilter.value.size > 0 && !projectFilter.value.has(log.projectId)) return;
    } else if (activeProjectId.value && log.projectId !== activeProjectId.value) {
      return;
    }

    if (msg.type === 'execution:started') {
      // Grow the provider chip row so newly-seen providers appear as filters.
      discoveredProviders.value = new Set([...discoveredProviders.value, log.providerId]);
      if (log.source) {
        discoveredSources.value = new Set([...discoveredSources.value, log.source]);
      }
      const idx = executions.value.findIndex((e) => e.id === log.id);
      if (idx === -1) executions.value = [log, ...executions.value];
      else executions.value = executions.value.map((e) => (e.id === log.id ? log : e));
      // Auto-prime an empty buffer for the new in-flight run so subsequent
      // log:entry events land somewhere even before the drawer is opened.
      if (!(log.id in relatedLogs.value)) {
        relatedLogs.value = { ...relatedLogs.value, [log.id]: [] };
      }
    } else {
      executions.value = executions.value.map((e) => (e.id === log.id ? log : e));
    }
    return;
  }

  if (msg.type === 'log:entry') {
    const parsed = ServerLogEntrySchema.safeParse((msg as { entry: unknown }).entry);
    if (!parsed.success) return;
    const entry = parsed.data;
    const runId = entry.extras?.runId;
    if (typeof runId !== 'string') return;
    // Merge only when we already track this run — either the drawer opened
    // once (fetched from disk) or execution:started primed an empty buffer.
    if (!(runId in relatedLogs.value)) return;
    // Per-run pause: drop live events until the reader resumes. On resume
    // loadRelatedLogs is called to catch up on the dropped window.
    if (pausedRunIds.value.has(runId)) return;
    relatedLogs.value = {
      ...relatedLogs.value,
      [runId]: [...relatedLogs.value[runId], entry],
    };
  }
});

onMounted(async () => {
  void loadAgents();
  void loadIssueUrlMap();
  void loadAllSources();
  // Await the initial load so we know whether the `?runId` from the URL is
  // on the loaded page before deciding to auto-expand the drawer.
  await load();
  window.addEventListener('keydown', onKeydown);
  // Dashboard → this section: `?runId=<id>` asks us to land with that run
  // already open. Silently no-ops when the run isn't on the loaded page
  // (edge case documented in the PRD for #56 — runs beyond the first 100
  // would need a server-side `id` filter, which is out of scope here).
  const runIdParam = route.query.runId;
  if (typeof runIdParam === 'string' && executions.value.some((e) => e.id === runIdParam)) {
    toggleRow(runIdParam);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  if (nowTimer !== null) {
    clearInterval(nowTimer);
    nowTimer = null;
  }
});

// Reload when the active project changes — same pattern as StatusesSection.
// Health panel → run list. Narrows to exactly the runs behind the number that
// was clicked: that agent, that failure class.
/**
 * Un contador del veredicto prende su filtro.
 *
 * "te esperan" son tres outcomes (`error`, `cancelled`, `truncated`), así que
 * pone los tres tokens de una: el contador cuenta una disposición y el filtro
 * tiene que dejar exactamente eso. Volver a tocarlo apaga — es un toggle, como
 * los conteos por outcome que reemplaza.
 */
function filterByDisposition(outcomes: string[]): void {
  const already = outcomes.every((oc) => hasToken('resultado', oc));
  const rest = filterTokens.value.filter((t) => t.field !== 'resultado');
  filterTokens.value = already ? rest : [...rest, ...outcomes.map((value) => ({ field: 'resultado', value }))];
}

/**
 * El filtro activo dicho corto, para la fila de controles bajo --bp-shell.
 * Arriba del breakpoint el input está a la vista con sus tokens, así que esto
 * no se dibuja — sería decir lo mismo dos veces.
 */
const mobileFilterSummary = computed<string | null>(() => {
  const tokens = filterTokens.value;
  if (!tokens.length) return null;
  const first = `${tokens[0].field}: ${tokens[0].value}`;
  return tokens.length === 1 ? first : `${first} +${tokens.length - 1}`;
});

function onHealthDrill(payload: { agentId: string; failureClass: string }): void {
  agentFilter.value = new Set([payload.agentId]);
  failureClassFilter.value = payload.failureClass;
  outcomeFilter.value = new Set();
  pendingFilter.value = false;
}

// ─── Página de un agente ─────────────────────────────────────────────────
// Qué agente está abierto vive en la URL (`:detailId`), igual que el editor
// de agentes y el de reglas: deep-linkable, y el sidebar no se pierde. Con un
// id en la ruta esta sección deja de ser el listado y pasa a ser la página.
const detailAgentId = computed<string | null>(() => {
  const id = route.params?.detailId;
  return typeof id === 'string' && id ? id : null;
});

function pushDetailId(agentId: string | undefined): void {
  if (!route.name) return;
  const params = { ...route.params };
  if (agentId === undefined) delete params.detailId;
  else params.detailId = agentId;
  void router.push({ name: route.name, params });
}

/**
 * A dónde lleva el `→` de la banda de salud.
 *
 * Con un agente señalado, a su página — que es donde se mudó la tabla de
 * diez columnas. Cuando el fallo es del SISTEMA no hay agente que señalar, y
 * antes eso emitía `''`: el `→` estaba dibujado y no hacía nada. Ahí el
 * destino es el roster, que es donde se comparan los siete.
 */
function openAgentPage(agentId: string): void {
  if (agentId) {
    pushDetailId(agentId);
    return;
  }
  if (isGlobal.value) {
    void router.push('/general/agentes');
    return;
  }
  // Sin proyecto resuelto no hay roster al que ir: `/projects/null/agentes` es
  // una pantalla que sólo puede fallar. Mismo guard que `agentHref`.
  const pid = activeProjectId.value;
  if (pid) void router.push(`/projects/${pid}/agentes`);
}

function closeAgentPage(): void {
  pushDetailId(undefined);
}

// Un drill desde la página vuelve al listado con el filtro puesto.
function onPageDrill(payload: { agentId: string; failureClass: string }): void {
  onHealthDrill(payload);
  closeAgentPage();
}

// Link al editor del agente. Se arma acá y no en la página porque es esta
// sección la que sabe en qué scope está; la página no importa la feature de
// agentes (feature → feature está prohibido).
const agentEditorPath = computed<string | null>(() => {
  const id = detailAgentId.value;
  if (!id) return null;
  const enc = encodeURIComponent(id);
  if (isGlobal.value) return `/general/agentes/${enc}`;
  const pid = activeProjectId.value;
  return pid ? `/projects/${encodeURIComponent(pid)}/agentes/${enc}` : null;
});


// In global scope the active project is irrelevant, so skip.
watch(activeProjectId, () => {
  if (isGlobal.value) return;
  // Reset filters that don't make sense across projects.
  agentFilter.value = new Set();
  providerFilter.value = new Set();
  sourceFilter.value = new Set();
  assigneeFilter.value = new Set();
  outcomeFilter.value = new Set();
  failureClassFilter.value = '';
  pendingFilter.value = false;
  expandedId.value = null;
  limit.value = DEFAULT_LIMIT;
  discoveredProviders.value = new Set();
  discoveredSources.value = new Set();
  discoveredAssignees.value = new Set();
  ruleFilter.value = new Set();
  kindFilter.value = new Set();
  discoveredRules.value = new Set();
  discoveredKinds.value = new Set();
  relatedLogs.value = {};
  relatedLoading.value = {};
  relatedError.value = {};
  fetchedRunIds.value = new Set();
  pausedRunIds.value = new Set();
  autoScroll.value = true;
  issueUrlByTaskId.value = {};
  void loadAgents();
  void loadIssueUrlMap();
  void load();
});

// Server-side filters: refetch on change. `immediate: false` (the default)
// keeps the initial load in onMounted from double-firing.
watch(
  [
    agentFilter,
    providerFilter,
    sourceFilter,
    assigneeFilter,
    outcomeFilter,
    failureClassFilter,
    ruleFilter,
    kindFilter,
    fromFilter,
    toFilter,
    traceIdFilter,
    limit,
    projectFilter,
  ],
  () => { void load(); },
);

// `pending` solo no toca al servidor. Pero junto a otros outcomes SÍ cambia lo
// que se pide (deja de mandarse `outcome`), así que ahí hay que recargar.
watch(pendingFilter, () => {
  if (outcomeFilter.value.size > 0) void load();
});
</script>

<template>
  <AgentHealthPage
    v-if="detailAgentId"
    :agent-id="detailAgentId"
    :project-id="isGlobal ? null : activeProjectId"
    :editor-path="agentEditorPath"
    @close="closeAgentPage"
    @drill="onPageDrill"
    @open="openAgentPage"
  />
  <section v-else class="settings-section">
    <!-- Sin `<h2>Ejecuciones</h2>` ni su descripción (R9, R12): la barra de
         identidad del shell ya dice el proyecto y la sección, y el párrafo
         describía lo que la lista muestra abajo. -->
    <!-- El resumen es un VEREDICTO: tres contadores por disposición y sólo los
         agentes fuera de banda (R10). Reemplaza al AgentHealthPanel, cuya tabla
         de diez columnas se mudó entera a la pantalla del agente. -->
    <HealthVerdict
      :project-id="isGlobal ? null : activeProjectId"
      :outcome-counts="outcomeCounts"
      @filter="filterByDisposition"
      @open="openAgentPage"
    />

    <!-- Lo que está corriendo AHORA, arriba del historial: es otra pregunta
         que "qué pasó", y es lo único sobre lo que todavía se puede actuar.
         Una fila más en una tabla ordenada por fecha se lee igual que una
         vieja. -->
    <RunningRunsPanel
      :project-id="isGlobal ? null : activeProjectId"
      @open="openRunFromPanel"
      @cancel="confirmCancelExecution"
    />

    <ListControlsBar
      :filter-count="filterTokens.length"
      :summary="mobileFilterSummary ?? undefined"
      title="Filtrar ejecuciones"
      @clear="filterTokens = []"
    >
      <!-- `Live` y `Actualizar` son controles de la LISTA, no encabezado de la
           pantalla: arriba ocupaban 90px antes de la primera fila (turno 8).
           El total de filas tampoco: la línea plegada del veredicto ya dice
           cuántos runs tiene el período, y decirlo dos veces no lo aclara. -->
      <template #tools>
        <button
          type="button"
          class="live-toggle"
          :class="{
            'live-toggle--on': liveMode && liveConnected,
            'live-toggle--pending': liveMode && !liveConnected,
          }"
          :aria-pressed="liveMode"
          :title="
            liveMode
              ? liveConnected
                ? 'Live: recibiendo eventos en tiempo real'
                : 'Live: intentando reconectar…'
              : 'Live desactivado — los cambios sólo aparecen al recargar'
          "
          @click="liveMode = !liveMode"
        >
          <span class="live-toggle-dot" aria-hidden="true"></span>
          Live
        </button>
        <button
          type="button"
          class="lcb-refresh"
          :disabled="loading"
          :aria-label="loading ? 'Cargando' : 'Actualizar'"
          :title="loading ? 'Cargando…' : 'Actualizar'"
          @click="load()"
        >{{ loading ? '◐' : '↺' }}</button>
      </template>

      <FilterQueryInput
        v-model="filterTokens"
        :fields="filterFields"
        default-field="tarea"
        testid="executions-filter"
        placeholder="Filtrar… un campo (agente, resultado, tarea…) o texto plano busca por título/id"
      />
    </ListControlsBar>

    <div v-if="error" class="items-error">{{ error }}</div>

    <!-- Sobre --bp-split la lista y el detalle se parten en dos columnas; sin
         detalle abierto no hay grilla, porque reservar 26rem vacías dejaría la
         lista angosta para nada. -->
    <div class="exec-split" :class="{ 'exec-split--open': isSplit && !!selectedExec }">
    <div class="exec-col">
    <div class="exec-list-wrapper">
      <!-- El encabezado son las columnas de 5d, y existe SÓLO donde hay
           columnas: bajo 768px la fila se apila y un encabezado no encabeza
           nada. Ordenar es de la tabla, no de la fila. -->
      <div class="exec-list-header" role="row">
        <span class="exec-h-anchor" aria-hidden="true"></span>
        <button
          type="button"
          class="exec-h-issue exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'startedAt' }"
          title="Ordenar por cuándo corrió"
          @click="selectExecColumn('startedAt')"
        >run{{ execSortArrow('startedAt') }}</button>
        <button
          type="button"
          class="exec-h-main exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'taskTitle' }"
          @click="selectExecColumn('taskTitle')"
        >tarea · razón{{ execSortArrow('taskTitle') }}</button>
        <button
          type="button"
          class="exec-h-agent exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'agentId' }"
          @click="selectExecColumn('agentId')"
        >agente{{ execSortArrow('agentId') }}</button>
        <button
          type="button"
          class="exec-h-dur exec-header-btn"
          :class="{ 'exec-header-btn--active': execSort.column === 'duration' }"
          @click="selectExecColumn('duration')"
        >dur.{{ execSortArrow('duration') }}</button>
        <span class="exec-h-verb">acción</span>
      </div>

      <!-- El orden no se recalcula solo: con el socket vivo, la fila que ibas a
           tocar se movería bajo el dedo cada vez que llega un evento. Misma
           pieza que en Tareas y Qué sigue. -->
      <button
        v-if="execMoved > 0"
        type="button"
        class="exec-moved"
        data-testid="executions-reorder"
        @click="freezeExecOrder"
      >
        {{ execMoved }} {{ execMoved === 1 ? 'cambió' : 'cambiaron' }} de lugar
        <span class="exec-moved-sep">·</span>
        <span class="exec-moved-cta">reordenar</span>
      </button>

      <p v-if="loading && !executions.length" class="exec-empty">Cargando ejecuciones…</p>
      <p v-else-if="!filteredExecutions.length" class="exec-empty">
        No hay ejecuciones para los filtros actuales.
      </p>

      <ul v-else class="exec-list" data-kbd-list="executions">
      <template v-for="row in displayRows" :key="row.key">
        <!-- El encabezado de bucket, en la misma secuencia que las filas: es
             lo que hace que esta pantalla se lea como un recorte del mismo
             orden que Tareas y Qué sigue (O6). -->
        <li v-if="row.kind === 'header'" class="exec-bucket">
          <BucketHeader
            :disposition="row.disposition"
            :count="row.count"
            :collapsible="row.disposition === 'closed'"
            :open="closedOpen"
            :meta="row.disposition === 'closed' ? closedMeta : undefined"
            @toggle="closedOpen = !closedOpen"
          />
        </li>

        <!-- El resumen de un disparo: la MISMA fila, con la regla en la columna
             del agente y el caret que abre sus acciones. -->
        <!-- El corte del bucket 1 (turno 8): cuántas quedan y qué comparten.
             `filtrar` prende el token de ese mismo eje — el texto y el filtro
             salen del mismo conteo, así que no pueden divergir. -->
        <li v-else-if="row.kind === 'more'" class="exec-more">
          <button
            type="button"
            class="exec-more__expand"
            data-testid="executions-more"
            @click="waitingExpanded = true"
          >
            {{ row.hidden }} más
            <span v-if="row.axis" class="exec-more__axis">· {{ row.axis }}</span>
          </button>
          <button
            v-if="row.token"
            type="button"
            class="exec-more__filter"
            data-testid="executions-more-filter"
            @click="applyAxisToken(row.token)"
          >filtrar</button>
        </li>

        <li
          v-else-if="row.firing"
          class="exec-card exec-card--firing"
          :class="{ 'exec-card--open': isFiringOpen(row.firing.key) }"
        >
          <RunRow
            class="exec-row"
            :execution="firingAsExec(row.firing)"
            :title="row.firing.taskTitle"
            :title-href="issueUrlFor(row.firing.taskId)"
            :issue-label="issueLabelFor(row.firing.taskId)"
            :agent="row.firing.ruleId ?? ''"
            :duration="formatDuration(row.firing.startedAt, row.firing.finishedAt)"
            :tag="isGlobal ? projectNameFor(row.firing.projectId) : null"
            :tag-title="`Proyecto: ${projectNameFor(row.firing.projectId)}`"
            :caret="isFiringOpen(row.firing.key) ? '▾' : '▸'"
            :note="`${row.firing.count} acciones`"
            :warn="row.firing.hadEarlierIssue
              ? 'Una acción anterior de este pipeline terminó en error/cancelled/truncated antes del resultado final mostrado.'
              : null"
            :has-verb="!!row.firing.running"
            :aria-expanded="isFiringOpen(row.firing.key)"
            :note-title="`Regla ${row.firing.ruleId ?? ''}${row.firing.eventType ? ` · ${row.firing.eventType}` : ''}`"
            @open="toggleFiring(row.firing.key)"
          >
            <template #verb>
              <button
                v-if="row.firing.running"
                type="button"
                class="exec-stop-btn"
                :disabled="isCancelling(row.firing.running.id)"
                :data-testid="`executions-stop-${row.firing.running.id}`"
                title="Detener ejecución"
                @click.stop="confirmCancelExecution(row.firing!.running!)"
              >{{ isCancelling(row.firing.running.id) ? '…' : '■ Detener' }}</button>
            </template>
          </RunRow>
        </li>

        <li
          v-else
          class="exec-card"
          :data-run-id="row.exec!.id"
          :class="{ 'exec-card--open': expandedId === row.exec!.id, 'exec-card--nested': row.nested }"
        >
          <!-- La acción de un disparo NO repite el título ni el proyecto: los
               dice el resumen del que cuelga, y repetirlos tres veces es lo que
               hacía ilegible la lista. La columna ancha dice QUÉ es (un agente o
               una acción, y de qué tipo); el nombre queda en la columna del
               agente, que es donde el encabezado lo anuncia. -->
          <RunRow
            class="exec-row"
            :execution="row.exec!"
            :title="row.nested ? (kindLabel(row.exec!) ? 'acción' : 'agente') : row.exec!.taskTitle"
            :title-href="row.nested ? null : issueUrlFor(row.exec!.taskId)"
            :issue-label="row.nested ? null : issueLabelFor(row.exec!.taskId)"
            :note="kindLabel(row.exec!)"
            :agent="row.nested ? row.exec!.agentId : row.exec!.agentId || row.exec!.ruleId || ''"
            :duration="formatDuration(row.exec!.startedAt, row.exec!.finishedAt)"
            :tag="isGlobal ? projectNameFor(row.exec!.projectId) : null"
            :tag-ghost="row.nested"
            :tag-title="`Proyecto: ${projectNameFor(row.exec!.projectId)}`"
            :cancel-requested="!!row.exec!.cancelRequestedAt"
            :has-verb="!!verbForRun(row.exec!)"
            :aria-expanded="expandedId === row.exec!.id"
            @open="toggleRow(row.exec!.id)"
          >
            <!-- Un verbo por fila, y sólo donde hay algo que hacer (O2). El
                 destino existe: abortar llama a su endpoint, resolver navega a
                 la pantalla de runs abortados. -->
            <template #verb>
              <button
                v-if="verbForRun(row.exec!)?.kind === 'cancel'"
                type="button"
                class="exec-stop-btn"
                :disabled="isCancelling(row.exec!.id)"
                :data-testid="`executions-stop-${row.exec!.id}`"
                title="Detener ejecución"
                @click.stop="confirmCancelExecution(row.exec!)"
              >{{ isCancelling(row.exec!.id) ? '…' : '■ Abortar' }}</button>
              <RouterLink
                v-else-if="verbForRun(row.exec!)?.href"
                class="exec-verb"
                :to="verbForRun(row.exec!)!.href!"
                :data-testid="`executions-verb-${row.exec!.id}`"
                @click.stop
              >
                → {{ verbForRun(row.exec!)!.label }}
                <span class="exec-verb-hint">{{ verbForRun(row.exec!)!.hint }}</span>
              </RouterLink>
            </template>
          </RunRow>
        </li>
      </template>
      </ul>

      <KbdBar />
    </div>

    <div v-if="executions.length === limit" class="load-more">
      <button type="button" class="btn-secondary" :disabled="loading" @click="loadMore()">
        Cargar más
      </button>
    </div>
    </div>

    <!-- El detalle: columna hermana sobre --bp-split, drawer flotante debajo.
         Es el MISMO marcado — un panel que entra desde la derecha y uno que
         está a la derecha se diferencian en dónde se posicionan, no en qué
         dicen. La transición sólo existe cuando flota: una columna que aparece
         deslizándose desde afuera de la pantalla no viene de ningún lado. -->
    <transition :name="isSplit ? 'exec-inline' : 'exec-drawer'">
      <aside
        v-if="selectedExec"
        class="exec-drawer"
        :class="{ 'exec-drawer--inline': isSplit }"
        role="dialog"
        aria-label="Detalle de la ejecución"
        data-testid="executions-detail-drawer"
      >
        <!-- Banda 1 · identidad. Qué run es, y nada más: el outcome lo dice el
             veredicto de abajo en grande, así que repetirlo acá como badge era
             decir dos veces lo mismo en 44px. -->
        <header class="exec-drawer__header" :class="{ 'exec-drawer__header--back': isMobile }">
          <div class="exec-drawer__title">
            <span class="exec-drawer__id">{{ issueLabelFor(selectedExec.taskId) ?? (isAction(selectedExec) ? 'acción' : 'run') }}</span>
            <!-- El proyecto sólo en la pestaña global: en la de un proyecto ya
                 lo dice la barra de identidad de la pantalla (R9). Y no se
                 repite la palabra que el id de la izquierda ya dijo. -->
            <span v-if="isGlobal" class="exec-drawer__crumb">
              {{ projectNameFor(selectedExec.projectId) }}
            </span>
          </div>
          <button
            type="button"
            class="exec-drawer__close"
            aria-label="Cerrar detalle"
            data-testid="executions-detail-close"
            @click="closeDetail()"
          >{{ isMobile ? '←' : '×' }}</button>
        </header>

        <div
          ref="drawerBodyEl"
          class="exec-drawer__body"
          @scroll.passive="onDrawerScroll"
        >
          <!-- Bandas 2 y 3 · veredicto y causa. -->
          <RunVerdict
            :execution="selectedExec"
            :issue-url="issueUrlFor(selectedExec.taskId)"
            :avg-duration-ms="agentAvgMs[selectedExec.agentId] ?? null"
            :rules-href="isGlobal ? null : `/projects/${selectedExec.projectId}/pipeline`"
            @copy-error="copyError(selectedExec.errorMsg ?? '')"
          />

          <span
            v-if="selectedExec.cancelRequestedAt"
            class="exec-cancel-requested"
            :title="`Cancelación solicitada: ${selectedExec.cancelRequestedAt}`"
          >cancelación solicitada</span>

          <!-- La meta completa: material de auditoría, plegado (ver `metaOpen`). -->
          <button
            type="button"
            class="detail-meta-toggle"
            :aria-expanded="metaOpen"
            data-testid="executions-meta-toggle"
            @click="metaOpen = !metaOpen"
          >
            <span class="detail-meta-caret" aria-hidden="true">{{ metaOpen ? '▾' : '▸' }}</span>
            meta del run
          </button>

          <template v-if="metaOpen">
            <div v-for="row in detailRows(selectedExec)" :key="row.label" class="detail-row">
              <span class="detail-label">{{ row.label }}</span>
              <pre v-if="row.pre" class="detail-value detail-value--pre">{{ row.value }}</pre>
              <button
                v-else-if="row.jumpToRunId"
                type="button"
                class="detail-value detail-value--link"
                :title="row.title"
                @click="jumpToRun(row.jumpToRunId)"
              >{{ row.value }}</button>
              <button
                v-else-if="row.filterByTraceId"
                type="button"
                class="detail-value detail-value--link"
                title="Filtrar por este traceId — todo lo que produjo el mismo delivery/scan"
                data-testid="executions-filter-trace"
                @click="applyTraceIdFilter(row.value)"
              >{{ row.value }}</button>
              <code v-else class="detail-value" :title="row.title">{{ row.value }}</code>
            </div>

            <div class="detail-json-block">
              <div class="detail-json-header">
                <span class="detail-label">JSON completo</span>
                <button
                  type="button"
                  class="btn-copy"
                  data-testid="executions-copy-json"
                  @click="copyJson(selectedExec)"
                >
                  Copiar JSON
                </button>
              </div>
              <div class="detail-json">
                <JsonTreeNode :data="selectedExec" path="" :depth="0" />
              </div>
            </div>
          </template>

          <!-- Banda 4 · el log. Es la evidencia, y ocupa lo que sobra; el log
               COMPLETO se abre aparte (`completo ↗`) en vez de scrollearse
               acá dentro. -->
          <div class="related-block">
            <div class="related-header">
              <span class="detail-label">
                {{ isAction(selectedExec) ? 'log de la regla' : 'log' }}
                <span
                  v-if="relatedLogs[selectedExec.id]"
                  class="related-count"
                >· {{ relatedLogs[selectedExec.id].length }} líneas</span>
              </span>
              <div class="related-actions">
                <button
                  v-if="liveMode"
                  type="button"
                  class="btn-copy pause-btn"
                  :class="{ 'pause-btn--paused': isPaused(selectedExec.id) }"
                  :title="
                    isPaused(selectedExec.id)
                      ? 'Reanudar el stream de logs para esta ejecución'
                      : 'Pausar el stream de logs (se refetch al reanudar)'
                  "
                  @click="togglePause(selectedExec)"
                >
                  {{ isPaused(selectedExec.id) ? '▶ Reanudar' : '⏸ Pausar' }}
                </button>
                <button
                  type="button"
                  class="btn-copy"
                  data-testid="executions-related-refresh"
                  :disabled="relatedLoading[selectedExec.id]"
                  @click="reloadRelatedLogs(selectedExec)"
                >
                  ↻ Recargar
                </button>
                <button
                  type="button"
                  class="btn-copy"
                  data-testid="executions-related-open-logs"
                  @click="openRunInLogs(selectedExec)"
                >
                  completo ↗
                </button>
              </div>
            </div>

            <div v-if="relatedLoading[selectedExec.id]" class="related-empty">
              Cargando logs relacionados…
            </div>
            <div v-else-if="relatedError[selectedExec.id]" class="items-error related-error">
              {{ relatedError[selectedExec.id] }}
            </div>
            <div
              v-else-if="relatedLogs[selectedExec.id] && relatedLogs[selectedExec.id].length === 0"
              class="related-empty"
            >
              No se encontraron entradas en <code>daemon.log</code> para
              {{ isAction(selectedExec) ? 'esta acción' : 'esta ejecución' }}.
              Los agentes async (tmux/iterm) no emiten <code>tool.call</code>/<code>tool.result</code>
              — sus tool calls quedan registrados por Claude Code, no por el daemon.
            </div>
            <div v-else-if="relatedLogs[selectedExec.id]" class="related-list-wrap">
              <button
                v-if="!autoScroll"
                type="button"
                class="autoscroll-hint"
                title="Volver al final y reanudar autoscroll"
                @click="() => { autoScroll = true; scrollRelatedToBottom(); }"
              >
                ↓ Ir al final (autoscroll pausado)
              </button>
              <ul
                class="related-list"
                data-testid="executions-related-list"
              >
              <template v-for="item in pairedRelatedLogs[selectedExec.id]" :key="item.key">
                <!-- Non-tool events: keep the original single-entry card -->
                <li
                  v-if="item.kind === 'other'"
                  class="related-card"
                  :class="{ 'related-card--open': expandedEventKey === item.key }"
                >
                  <button
                    type="button"
                    class="related-row"
                    :aria-expanded="expandedEventKey === item.key"
                    @click="toggleEvent(item.key)"
                  >
                    <span class="related-time">{{ formatTime(item.entry.time) }}</span>
                    <span
                      class="related-level"
                      :style="{
                        background: levelColor(item.entry.level).bg,
                        color: levelColor(item.entry.level).fg,
                      }"
                    >{{ item.entry.level }}</span>
                    <span v-if="eventFromExtras(item.entry)" class="related-event">
                      {{ eventFromExtras(item.entry) }}
                    </span>
                    <span class="related-msg">{{ truncateMsg(item.entry.msg) }}</span>
                    <span class="related-chevron" aria-hidden="true">
                      {{ expandedEventKey === item.key ? '▾' : '▸' }}
                    </span>
                  </button>
                  <div v-if="expandedEventKey === item.key" class="related-detail">
                    <div class="related-detail-header">
                      <span class="detail-label">JSON completo del evento</span>
                      <button
                        type="button"
                        class="btn-copy"
                        data-testid="executions-related-copy-json"
                        @click="copyEventJson(item.entry)"
                      >
                        Copiar JSON
                      </button>
                    </div>
                    <div class="related-detail-json">
                      <JsonTreeNode :data="item.entry" path="" :depth="0" />
                    </div>
                  </div>
                </li>

                <!-- Tool call + result merged into a single card -->
                <li
                  v-else
                  class="related-card related-card--tool"
                  :class="{ 'related-card--open': expandedEventKey === item.key }"
                >
                  <button
                    type="button"
                    class="related-row"
                    :aria-expanded="expandedEventKey === item.key"
                    @click="toggleEvent(item.key)"
                  >
                    <span class="related-time">
                      {{ formatTime((headerEntryFor(item) as any).time) }}
                    </span>
                    <span
                      class="related-level"
                      :style="{
                        background: levelColor((headerEntryFor(item) as any).level).bg,
                        color: levelColor((headerEntryFor(item) as any).level).fg,
                      }"
                    >{{ (headerEntryFor(item) as any).level }}</span>
                    <span class="related-tool">
                      <span
                        class="related-tool-tag"
                        :class="{
                          'related-tool-tag--pending': !item.result,
                          'related-tool-tag--orphan': !item.call,
                        }"
                        :title="
                          item.call && item.result
                            ? 'request + response'
                            : item.call
                              ? 'esperando response…'
                              : 'response sin request registrado'
                        "
                      >
                        {{ item.call && item.result ? 'tool' : item.call ? 'call' : 'result' }}
                      </span>
                      <code class="related-tool-name">
                        {{ toolFromExtras(headerEntryFor(item) as any) }}
                      </code>
                    </span>
                    <span class="related-msg">
                      {{ truncateMsg((headerEntryFor(item) as any).msg) }}
                    </span>
                    <span class="related-chevron" aria-hidden="true">
                      {{ expandedEventKey === item.key ? '▾' : '▸' }}
                    </span>
                  </button>

                  <div v-if="expandedEventKey === item.key" class="related-detail">
                    <div v-if="item.call" class="related-detail-section">
                      <div class="related-detail-header">
                        <span class="detail-label">Request (tool.call)</span>
                        <button
                          type="button"
                          class="btn-copy"
                          @click="copyEventJson(item.call)"
                        >
                          Copiar JSON
                        </button>
                      </div>
                      <div class="related-detail-json">
                        <JsonTreeNode :data="item.call" path="" :depth="0" />
                      </div>
                    </div>
                    <div v-if="item.result" class="related-detail-section">
                      <div class="related-detail-header">
                        <span class="detail-label">Response (tool.result)</span>
                        <button
                          type="button"
                          class="btn-copy"
                          @click="copyEventJson(item.result)"
                        >
                          Copiar JSON
                        </button>
                      </div>
                      <div class="related-detail-json">
                        <JsonTreeNode :data="item.result" path="" :depth="0" />
                      </div>
                    </div>
                    <div v-if="!item.result" class="related-detail-note">
                      Aún no se registra el <code>tool.result</code> — el tool está corriendo o
                      la ejecución terminó antes de emitirlo.
                    </div>
                  </div>
                </li>
              </template>
            </ul>
            </div>
          </div>
        </div>
        <!-- Banda 5 · acciones. Por estado, y sólo las que EXISTEN: mientras
             corre no hay nada que iniciar (ningún botón es primary, y el único
             es abortar); cerrado, lo único que el detalle puede ofrecer es
             volver al issue. Reintentar vive en la fila de la tarea, que es
             donde la acción pertenece (ver `verbForRun`). -->
        <footer v-if="detailActions.length" class="exec-actions" data-testid="executions-detail-actions">
          <button
            v-if="!selectedExec.finishedAt"
            type="button"
            class="exec-stop-btn exec-actions__btn"
            :disabled="isCancelling(selectedExec.id)"
            data-testid="executions-detail-stop"
            @click="confirmCancelExecution(selectedExec)"
          >{{ isCancelling(selectedExec.id) ? 'Deteniendo…' : '■ Abortar' }}</button>
          <RouterLink
            v-if="verbForRun(selectedExec)?.href"
            class="exec-actions__btn exec-actions__btn--primary"
            :to="verbForRun(selectedExec)!.href!"
            data-testid="executions-detail-verb"
          >{{ verbForRun(selectedExec)!.label }}</RouterLink>
          <a
            v-if="issueUrlFor(selectedExec.taskId)"
            class="exec-actions__btn"
            :href="issueUrlFor(selectedExec.taskId)!"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="executions-detail-issue"
          >La tarea ↗</a>
        </footer>
      </aside>
    </transition>
    </div>
  </section>

  <ConfirmDialog
    :open="pendingConfirm != null"
    :title="pendingConfirm?.title"
    :message="pendingConfirm?.message ?? ''"
    :confirm-label="pendingConfirm?.confirmLabel"
    danger
    @confirm="runConfirm"
    @cancel="cancelConfirm"
  />
</template>

<style scoped>
/* .section-head-actions ya es global (theme.css, la usan otras siete
   secciones). .live-toggle / .live-dot / @keyframes live-pulse también
   viven ahí — ServerLogsSection.vue usa el mismo toggle "Live" y duplicarlas
   acá las hubiera desincronizado en el primer retoque de una de las dos
   copias. */

.btn-primary {
  flex-shrink: 0;
  padding: 0.35rem 0.8rem;
  background: var(--accent);
  color: var(--panel);
  border: none;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.btn-primary:hover { background: var(--accent); }
.btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

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
.btn-copy:disabled { opacity: 0.6; cursor: not-allowed; }

.empty { font-size: 0.875rem; color: var(--fg-dim); padding: 0.5rem 0; }
.items-error {
  padding: 0.6rem 0.85rem;
  background: var(--red-bg);
  border: 1px solid var(--danger);
  border-radius: 6px;
  font-size: 0.82rem;
  color: var(--danger);
  margin-bottom: 0.75rem;
}

/* ─── Summary row (outcome counts) ─────────────────────────────────── */
.exec-summary {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.6rem;
  margin-bottom: 0.5rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 0.75rem;
  flex-wrap: wrap;
}
.exec-summary__total { color: var(--fg-dim); margin-right: 0.4rem; }
.exec-summary__count {
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
.exec-summary__count:hover { background: var(--panel-hi); }
.exec-summary__count[aria-pressed='true'] { outline: 2px solid var(--fg); outline-offset: 1px; }
.exec-summary__count b { font-weight: 700; }
.exec-summary__count--success   { color: var(--accent); }
.exec-summary__count--error     { color: var(--danger); }
.exec-summary__count--cancelled { color: var(--fg-mute); }
.exec-summary__count--truncated { color: var(--warn); }
.exec-summary__count--pending   { color: var(--fg-dim); }
.exec-summary__count--zero { opacity: 0.4; }

/* ─── Table wrapper + sticky sortable header ───────────────────────── */
/* ── La segunda columna (--bp-split) ─────────────────────────────────────── */
.exec-split { display: flex; flex-direction: column; min-width: 0; }
.exec-col { min-width: 0; }
@media (min-width: 1100px) {
  .exec-split--open {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 26rem;
    gap: 1rem;
    align-items: start;
  }
}

/* La lista es un CONTENEDOR de consulta, y de ahí sale si la fila se apila.
   No es un capricho sobre el media query: con el detalle abierto al lado, la
   ventana mide 1440 y la lista 470 — o sea que el ancho de la ventana pasa a
   ser mentira justo cuando más importa. `RunRow` y el encabezado preguntan por
   este contenedor, así que la fila se apila sola cuando se abre el detalle. */
.exec-list-wrapper {
  position: relative;
  container: exec-list / inline-size;
}
/* Las columnas se declaran UNA vez, acá, y las heredan la fila y su
   encabezado: escritas por separado, la primera vez que una cambie el
   encabezado deja de nombrar la columna que tiene debajo, que es lo único que
   hace. Son las de 5d, dibujado a 1280. */
.exec-list-wrapper { --rr-cols: 16px 8ch minmax(0, 1fr) 12ch 8ch 22ch; }

/* No existe donde la fila se apila: un encabezado de columnas no encabeza
   nada. Mismo umbral que `RunRow` — 47rem de LISTA, ver el porqué ahí. */
.exec-list-header { display: none; }
@container exec-list (min-width: 47rem) {
  .exec-list-header {
    display: grid;
    grid-template-columns: var(--rr-cols);
    gap: 0.65rem;
    align-items: center;
    height: var(--row-h);
    padding: 0 0.65rem;
    background: var(--panel-hi);
    border: 1px solid var(--border);
    border-radius: 6px 6px 0 0;
    /* Misma base que `.rr`: `ch` se mide contra la fuente del contenedor, y con
       dos bases distintas el encabezado no cae sobre su columna. */
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: var(--tracking-lbl);
    position: sticky;
    top: 0;
    z-index: 1;
  }
}
.exec-h-dur { text-align: right; }
.exec-h-verb { color: var(--fg-dimmer); }
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
.exec-header-btn:hover { color: var(--fg); }
.exec-header-btn--active { color: var(--fg); }
.exec-empty {
  padding: 1.5rem 0.75rem;
  text-align: center;
  color: var(--fg-dim);
  font-size: 0.85rem;
  border: 1px solid var(--border);
  border-top: none;
  border-radius: 0 0 6px 6px;
  margin: 0;
}

/* Mismo control que en Tareas: un blanco táctil con el glifo, sin caja. */
.lcb-refresh {
  flex: 0 0 auto;
  width: var(--tap-h);
  height: var(--tap-h);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  cursor: pointer;
}
.lcb-refresh:hover:not(:disabled) { color: var(--accent); }
.lcb-refresh:disabled { opacity: 0.5; cursor: not-allowed; }

/* El corte del bucket 1: dice cuántas quedan y qué comparten. Es una fila de
   la lista, no un botón suelto — vive en la secuencia, donde el orden la puso. */
.exec-more {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 1rem;
  border-bottom: 1px solid var(--border-mute);
  background: var(--panel-alt);
}
.exec-more__expand,
.exec-more__filter {
  min-height: var(--tap-h);
  padding: 0;
  border: none;
  background: none;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  cursor: pointer;
}
.exec-more__expand { flex: 1 1 auto; min-width: 0; color: var(--fg-mute); text-align: left; }
.exec-more__expand:hover { color: var(--fg); }
.exec-more__axis { color: var(--fg-dim); }
.exec-more__filter { flex: 0 0 auto; color: var(--accent); text-decoration: underline; }

/* El aviso de reorden: información, no alarma — describe el estado del ORDEN,
   no el de un run. Misma pieza que en Tareas. */
.exec-moved {
  display: flex;
  align-items: center;
  gap: 0.5ch;
  width: 100%;
  min-height: var(--tap-h);
  padding: 0 1rem;
  border: none;
  background: var(--panel-alt);
  color: var(--info);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  text-align: left;
  cursor: pointer;
}
.exec-moved:hover { background: var(--panel-hi); }
.exec-moved-sep { color: var(--fg-dimmer); }
.exec-moved-cta { text-decoration: underline; }

.exec-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.exec-card {
  border: 1px solid var(--border);
  border-top: none;
  background: var(--panel);
  overflow: hidden;
}
.exec-card:last-child { border-radius: 0 0 6px 6px; }
.exec-card--open { border-color: var(--info); background: var(--panel-hi); box-shadow: inset 3px 0 0 var(--accent); }

/* ─── Right-side detail drawer ───────────────────────────────────────── */
.exec-drawer {
  position: fixed;
  /* Debajo de la barra de chrome, no detrás: el drawer tiene z-index 40 y la
     barra 50, así que con `top: 0` su header (título + badge de outcome)
     quedaba tapado. Subirle el z-index no sirve — el drawer no es
     full-screen ni tiene backdrop, y taparía el estado global de la barra. */
  top: var(--chrome-h);
  right: 0;
  bottom: 0;
  width: 60vw;
  min-width: 420px;
  background: var(--panel);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 24px rgba(15, 23, 42, 0.08);
  display: flex;
  flex-direction: column;
  z-index: 40;
}
/* ── Banda 1 · identidad ─────────────────────────────────────────────────── */
.exec-drawer__id {
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  font-weight: 700;
  color: var(--fg);
}
.exec-drawer__crumb {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* La meta completa, plegada: es material de auditoría, no lo que se viene a
   ver. Se toca, así que mide --tap-h. */
.detail-meta-toggle {
  display: flex;
  align-items: center;
  gap: 0.6ch;
  width: 100%;
  min-height: var(--tap-h);
  padding: 0;
  border: none;
  background: none;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  text-align: left;
  cursor: pointer;
}
.detail-meta-toggle:hover { color: var(--fg); }
.detail-meta-caret { color: var(--fg-dimmer); }

/* ── Banda 5 · acciones ──────────────────────────────────────────────────── */
.exec-actions {
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem 0.85rem calc(0.5rem + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border-hi);
  background: var(--panel);
}
.exec-actions__btn {
  flex: 1 1 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* La fila de la acción principal de la pantalla: el pulgar la busca sin
     mirar (--tap-h-lg, igual que `StickyActionBar`). */
  min-height: var(--tap-h-lg);
  padding: 0 0.9rem;
  border: 1px solid var(--border-hi);
  border-radius: var(--radius-sm);
  background: var(--panel-alt);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  text-align: center;
  text-decoration: none;
  cursor: pointer;
}
.exec-actions__btn:hover { background: var(--panel-hi); color: var(--fg); }
.exec-actions__btn--primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--panel);
}
.exec-actions__btn--primary:hover { background: var(--accent); color: var(--panel); }
/* Abortar hereda la caja de la fila, pero acá es una acción de pantalla. */
.exec-actions .exec-stop-btn { flex: 1 1 0; min-height: var(--tap-h-lg); }

/* Como columna no flota: se queda pegado arriba mientras la lista scrollea al
   lado, que es lo que permite recorrer runs sin perder el detalle de vista. */
.exec-drawer--inline {
  position: sticky;
  top: calc(var(--chrome-h) + 0.5rem);
  width: auto;
  min-width: 0;
  max-height: calc(100vh - var(--chrome-h) - 2rem);
  border-left: 1px solid var(--border);
  box-shadow: none;
}

/* Bajo --bp-shell no es un panel: es la pantalla. Medía 420px de `min-width`
   sobre un teléfono de 390, así que tapaba la lista igual pero con 31px de su
   contenido cortados contra el borde izquierdo — y el `×` de cerrar era lo
   único que se alcanzaba bien. Acá ocupa todo y se cierra con `←` (A3, A5). */
@media (max-width: 768px) {
  .exec-drawer {
    top: var(--chrome-h);
    left: 0;
    right: 0;
    width: auto;
    min-width: 0;
    border-left: none;
    box-shadow: none;
    z-index: 70;
  }
  /* El `←` es volver: va primero, no en la esquina de cerrar. */
  .exec-drawer__header--back { flex-direction: row-reverse; justify-content: flex-end; gap: 0.6rem; }
}

.exec-drawer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--panel-alt);
}
.exec-drawer__title {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
}
.exec-drawer__title h3 { margin: 0; font-size: 1rem; color: var(--fg); }
.exec-drawer__close {
  padding: 0.15rem 0.55rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  background: var(--panel);
  color: var(--fg-mute);
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
}
.exec-drawer__close:hover { background: var(--panel-hi); color: var(--fg); }
.exec-drawer__body {
  flex: 1;
  overflow: auto;
  padding: 0.85rem 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.exec-drawer__task {
  margin: 0 0 0.4rem;
  font-weight: 500;
  color: var(--fg);
  font-size: 0.95rem;
}
.exec-drawer__task a { color: var(--accent); text-decoration: none; }
.exec-drawer__task a:hover { text-decoration: underline; }

.exec-drawer-enter-active,
.exec-drawer-leave-active { transition: transform 0.18s ease, opacity 0.18s ease; }
.exec-drawer-enter-from,
.exec-drawer-leave-to { transform: translateX(100%); opacity: 0; }

/* El resumen de un disparo de regla. Se dibuja como una fila normal —misma
   grilla, mismo estado, misma altura— porque para escanear la lista ES la
   fila; lo único que la marca es el caret y un fondo apenas distinto. */
.exec-card--firing { background: var(--panel-alt); }

/* Una acción abierta desde el resumen de su disparo. El sangrado más la guía a
   la izquierda es lo que dice "esto lo lanzó aquella regla" — la regla es el
   padre de las dos, ninguna acción lo es de su hermana. */
.exec-card--nested { margin-left: 1.5rem; border-left: 2px solid var(--border); }

/* El verbo que navega. `--tap-h` de área porque se toca, y el `hint` dice a
   dónde lleva — que es lo que evita que prometa de más. */
.exec-verb {
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  min-height: var(--tap-h);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  text-decoration: none;
  white-space: nowrap;
}
.exec-verb:hover { background: transparent; color: var(--accent); text-decoration: underline; }
.exec-verb-hint { color: var(--fg-dimmer); }

.exec-stop-btn {
  padding: 0.3rem 0.65rem;
  border: 1px solid var(--danger);
  border-radius: 6px;
  background: var(--panel);
  color: var(--danger);
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  box-sizing: border-box;
  text-align: center;
}
.exec-stop-btn:hover { background: var(--red-bg); }
.exec-stop-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.exec-drawer__header-actions { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
.exec-cancel-requested {
  flex-shrink: 0;
  font-size: 0.7rem;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
  background: var(--yellow-bg);
  color: var(--warn);
  border: 1px solid var(--warn);
  white-space: nowrap;
}
.exec-outcome {
  flex-shrink: 0;
  font-size: 0.7rem;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 600;
  text-transform: lowercase;
  width: 90px;
  text-align: center;
  box-sizing: border-box;
}

.exec-detail {
  padding: 0.75rem 0.85rem;
  border-top: 1px solid var(--border);
  background: var(--panel-alt);
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.detail-row { display: flex; gap: 0.6rem; align-items: flex-start; font-size: 0.8rem; }
.detail-label { min-width: 90px; color: var(--fg-dim); font-weight: 500; }
.detail-value { color: var(--fg); font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.78rem; word-break: break-all; }
.detail-value--pre { white-space: pre-wrap; margin: 0; background: var(--panel); border: 1px solid var(--border); padding: 0.4rem 0.55rem; border-radius: 4px; flex: 1; }
.detail-value--link { background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; text-align: left; text-decoration: underline; text-underline-offset: 2px; }
.detail-value--link:hover { color: var(--fg); }

.related-block {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: 0.5rem;
  padding: 0.55rem 0.65rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.related-header { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.related-actions { display: flex; gap: 0.35rem; flex-wrap: wrap; }
.related-count { color: var(--fg-dim); font-weight: 400; margin-left: 0.25rem; font-size: 0.72rem; }
.related-empty { font-size: 0.78rem; color: var(--fg-dim); padding: 0.35rem 0; line-height: 1.5; }
.related-empty code {
  background: var(--panel-hi);
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  font-size: 0.72rem;
}
.related-error { margin: 0; }
.related-list-wrap { position: relative; display: flex; flex-direction: column; }
.autoscroll-hint {
  align-self: center;
  position: sticky;
  top: 0.25rem;
  z-index: 2;
  margin: 0.25rem 0;
  padding: 0.3rem 0.7rem;
  background: var(--panel-alt);
  color: var(--fg);
  border: 1px solid var(--border-hi);
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
  transition: background 120ms, color 120ms;
}
.autoscroll-hint:hover { background: var(--fg); color: var(--panel-alt); }
.pause-btn--paused {
  background: var(--yellow-bg);
  border-color: var(--warn);
  color: var(--warn);
}
.related-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  border-top: 1px solid var(--panel-hi);
  padding-top: 0.35rem;
}
.related-card {
  border-radius: 4px;
  overflow: hidden;
}
/* Tool-call cards get a left rail in warn so they pop out of the feed
   without pouring a strong tint over the message. */
.related-card--tool {
  background: var(--panel-alt);
  box-shadow: inset 3px 0 0 0 var(--warn);
}
.related-card--open { background: var(--panel-hi); }
/* Two-row layout so events read cleanly even in the narrow drawer:
   line 1 = time + level chip + tool/event tag,
   line 2 = message (wrapped across full width). */
.related-row {
  display: grid;
  grid-template-columns: auto auto 1fr auto;
  grid-template-rows: auto auto;
  align-items: center;
  gap: 0.15rem 0.5rem;
  width: 100%;
  padding: 0.35rem 0.4rem;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
  font-size: 0.76rem;
  color: var(--fg);
}
.related-row:hover { background: var(--panel-hi); }
.related-chevron {
  color: var(--fg-dim);
  font-size: 0.8rem;
  grid-column: 4;
  grid-row: 1 / span 2;
  align-self: center;
}
.related-detail {
  padding: 0.5rem 0.6rem 0.6rem;
  border-top: 1px solid var(--border);
  background: var(--panel);
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
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.72rem;
  color: var(--fg);
  max-height: 360px;
  overflow: auto;
}
.related-time {
  grid-column: 1;
  grid-row: 1;
  font-variant-numeric: tabular-nums;
  color: var(--fg-dim);
  font-size: 0.72rem;
  font-family: 'SF Mono', 'Fira Code', monospace;
  white-space: nowrap;
}
.related-level {
  grid-column: 2;
  grid-row: 1;
  font-size: 0.65rem;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  font-weight: 600;
  text-transform: lowercase;
  min-width: 46px;
  text-align: center;
  justify-self: start;
}
.related-tool {
  grid-column: 3;
  grid-row: 1;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
  overflow: hidden;
}
.related-tool-tag {
  font-size: 0.65rem;
  padding: 0.05rem 0.4rem;
  border-radius: 3px;
  background: var(--info);
  color: var(--panel);
  text-transform: lowercase;
  font-weight: 600;
  flex-shrink: 0;
}
.related-tool-tag--pending { background: var(--warn); }
.related-tool-tag--orphan { background: var(--fg-dim); }
.related-detail-section { display: flex; flex-direction: column; gap: 0.35rem; }
.related-detail-section + .related-detail-section { margin-top: 0.5rem; }
.related-detail-note {
  margin-top: 0.4rem;
  padding: 0.4rem 0.55rem;
  border: 1px dashed var(--border-hi);
  border-radius: 4px;
  background: var(--yellow-bg);
  color: var(--warn);
  font-size: 0.72rem;
  line-height: 1.4;
}
.related-detail-note code { font-family: 'SF Mono', 'Fira Code', monospace; }
.related-tool-name {
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--info);
  font-size: 0.72rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.related-event {
  grid-column: 3;
  grid-row: 1;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--fg-dim);
  font-size: 0.7rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.related-msg {
  grid-column: 1 / span 3;
  grid-row: 2;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-mute);
  padding-left: 0.1rem;
}

.detail-json-block { display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.35rem; }
.detail-json-header { display: flex; justify-content: space-between; align-items: center; }
.detail-json {
  margin: 0;
  padding: 0.55rem 0.7rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  color: var(--fg);
  max-height: 480px;
  overflow: auto;
}

.load-more { display: flex; justify-content: center; margin-top: 0.85rem; }

</style>