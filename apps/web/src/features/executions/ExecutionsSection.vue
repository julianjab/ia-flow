
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
} from '@ia-flow/shared';
import { cancelExecution, type ExecutionLog, fetchExecutions, fetchExecutionSources } from './api';
import AgentHealthPanel from './AgentHealthPanel.vue';
import AgentHealthPage from './AgentHealthPage.vue';

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
 *  terminó. Ya cerrado, gana el peor — un `script` en rojo importa aunque el
 *  agente después haya salido bien. */
function firingOutcome(rows: ExecutionLog[]): ExecutionLog['outcome'] {
  if (rows.some((r) => !r.finishedAt)) return null;
  let worst: ExecutionLog['outcome'] = 'success';
  for (const r of rows) {
    const rank = OUTCOME_RANK[r.outcome ?? 'pending'] ?? 99;
    if (rank > (OUTCOME_RANK[worst ?? 'pending'] ?? 99)) worst = r.outcome;
  }
  return worst;
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
  return {
    key,
    ruleId: head.ruleId ?? null,
    eventType: head.eventType ?? null,
    projectId: head.projectId,
    taskId: head.taskId,
    taskTitle: head.taskTitle,
    startedAt,
    finishedAt,
    outcome: firingOutcome(group),
    providerId: agentRow?.providerId ?? '',
    count: group.length,
    running: unfinished.length === 1 ? unfinished[0] : null,
    children: byPosition,
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

// Compact date column matching the Logs table: HH:MM:SS today, "DD MMM HH:MM"
// for older entries. Full ISO available on hover. Locale falls back to the
// browser's default so a Spanish machine shows "ene" and a US one shows "Jan"
// — everything is rendered in the operator's local timezone.
// Locale FIJO y no el del dispositivo: la app está en español, así que un
// teléfono en inglés daría 'Aug 30, 1:53 PM' en medio de una UI en español.
// Con i18n de verdad esto pasa a seguir la preferencia del usuario.
const monthFormatter = new Intl.DateTimeFormat('es', { month: 'short' });
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
  return sameDay ? hms : `${pad(d.getDate())} ${monthFormatter.format(d)} ${hms}`;
}

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

function openAgentPage(agentId: string): void {
  pushDetailId(agentId);
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
  />
  <section v-else class="settings-section">
    <div class="section-header">
      <div>
        <h2>Ejecuciones</h2>
        <p class="section-desc">
          Historial de agentes ejecutados sobre las tareas de este proyecto.
          Los filtros de agente, outcome y fechas se aplican en el servidor.
        </p>
      </div>
      <div class="section-head-actions">
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
          class="btn-primary"
          :disabled="loading"
          @click="load()"
        >
          {{ loading ? 'Cargando…' : '↺ Actualizar' }}
        </button>
      </div>
    </div>

    <AgentHealthPanel
      :project-id="isGlobal ? null : activeProjectId"
      @drill="onHealthDrill"
      @open="openAgentPage"
    />

    <FilterQueryInput
      v-model="filterTokens"
      :fields="filterFields"
      default-field="tarea"
      testid="executions-filter"
      placeholder="Filtrar… un campo (agente, resultado, tarea…) o texto plano busca por título/id"
    />

    <div v-if="error" class="items-error">{{ error }}</div>

    <!-- El conteo ES el filtro: clickearlo prende el token `resultado:<x>`, el
         mismo que se escribe en el input. Un atajo, no un segundo camino. -->
    <div class="exec-summary" aria-label="Resumen por outcome">
      <span class="exec-summary__total">{{ executions.length }} ejecuciones</span>
      <button
        v-for="oc in OUTCOME_ORDER"
        :key="oc"
        type="button"
        class="exec-summary__count"
        :class="[
          `exec-summary__count--${oc}`,
          { 'exec-summary__count--zero': outcomeCounts[oc] === 0 },
        ]"
        :aria-pressed="hasToken('resultado', oc)"
        :title="`Filtrar por resultado:${oc}`"
        :data-testid="`executions-summary-${oc}`"
        @click="toggleToken('resultado', oc)"
      >{{ oc }} <b>{{ outcomeCounts[oc] }}</b></button>
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
        >Proveedor{{ execSortArrow('providerId') }}</button>
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
        >Resultado{{ execSortArrow('outcome') }}</button>
        <span class="exec-chevron"></span>
        <span class="exec-stop-spacer" aria-hidden="true"></span>
      </div>

      <p v-if="loading && !executions.length" class="exec-empty">Cargando ejecuciones…</p>
      <p v-else-if="!filteredExecutions.length" class="exec-empty">
        No hay ejecuciones para los filtros actuales.
      </p>

      <ul v-else class="exec-list" data-kbd-list="executions">
      <template v-for="row in groupedExecutions" :key="row.key">
        <li
          v-if="row.firing"
          class="exec-card exec-card--firing"
          :class="{ 'exec-card--open': isFiringOpen(row.firing.key) }"
        >
          <div class="exec-card-inner">
            <button
              type="button"
              class="exec-row"
              data-kbd-item
              :aria-expanded="isFiringOpen(row.firing.key)"
              :title="`Regla ${row.firing.ruleId ?? ''}${row.firing.eventType ? ` · ${row.firing.eventType}` : ''}`"
              @click="toggleFiring(row.firing.key)"
            >
              <span
                v-if="isGlobal"
                class="exec-project-tag"
                :title="`Proyecto: ${projectNameFor(row.firing.projectId)}`"
              >{{ projectNameFor(row.firing.projectId) }}</span>
              <span class="exec-title">
                <span class="exec-caret" aria-hidden="true">{{ isFiringOpen(row.firing.key) ? '▾' : '▸' }}</span>
                <a
                  v-if="issueUrlFor(row.firing.taskId)"
                  :href="issueUrlFor(row.firing.taskId)!"
                  target="_blank"
                  rel="noopener noreferrer"
                  @click.stop
                >{{ row.firing.taskTitle }} ↗</a>
                <template v-else>{{ row.firing.taskTitle }}</template>
              </span>
              <span class="exec-kind">{{ row.firing.count }} acciones</span>
              <span class="exec-meta exec-agent">{{ row.firing.ruleId ?? '' }}</span>
              <span class="exec-meta exec-provider">{{ row.firing.providerId }}</span>
              <span class="exec-meta exec-date" :title="row.firing.startedAt">{{ formatDateCompact(row.firing.startedAt) }}</span>
              <span class="exec-meta exec-duration">{{ formatDuration(row.firing.startedAt, row.firing.finishedAt) }}</span>
              <span
                class="exec-outcome"
                :style="{
                  background: outcomeColor(row.firing.outcome).bg,
                  color: outcomeColor(row.firing.outcome).fg,
                }"
              >{{ outcomeLabel(row.firing.outcome) }}</span>
              <span class="exec-chevron" aria-hidden="true"></span>
            </button>
            <div class="exec-stop-slot">
              <button
                v-if="row.firing.running"
                type="button"
                class="exec-stop-btn"
                :disabled="isCancelling(row.firing.running.id)"
                :data-testid="`executions-stop-${row.firing.running.id}`"
                title="Detener ejecución"
                @click.stop="confirmCancelExecution(row.firing.running!)"
              >{{ isCancelling(row.firing.running.id) ? '…' : '■ Detener' }}</button>
            </div>
          </div>
        </li>
        <li
          v-else
          class="exec-card"
          :class="{ 'exec-card--open': expandedId === row.exec!.id, 'exec-card--nested': row.nested }"
        >
          <div class="exec-card-inner">
            <button
              type="button"
              class="exec-row"
              data-kbd-item
              @click="toggleRow(row.exec!.id)"
              :aria-expanded="expandedId === row.exec!.id"
            >
              <!-- En un hijo el tag queda invisible pero PRESENTE: sacarlo del
                   todo correría sus columnas respecto de las del resumen. -->
              <span
                v-if="isGlobal"
                class="exec-project-tag"
                :class="{ 'exec-project-tag--ghost': row.nested }"
                :title="`Proyecto: ${projectNameFor(row.exec!.projectId)}`"
              >{{ projectNameFor(row.exec!.projectId) }}</span>
              <!-- La acción de un disparo NO repite el título ni el proyecto:
                   los dice el resumen del que cuelga, y repetirlos tres veces
                   es lo que hacía ilegible la lista. La columna ancha dice QUÉ
                   es (un agente o una acción, y de qué tipo); el nombre queda
                   en la columna del agente, que es donde el encabezado lo
                   anuncia y donde el ojo ya lo busca. -->
              <span v-if="row.nested" class="exec-title exec-title--action">
                <span class="exec-kind">{{ kindLabel(row.exec!) ? 'acción' : 'agente' }}</span>
                <span v-if="kindLabel(row.exec!)" class="exec-action-kind">{{ kindLabel(row.exec!) }}</span>
              </span>
              <template v-else>
                <span class="exec-title">
                  <a
                    v-if="issueUrlFor(row.exec!.taskId)"
                    :href="issueUrlFor(row.exec!.taskId)!"
                    target="_blank"
                    rel="noopener noreferrer"
                    @click.stop
                  >{{ row.exec!.taskTitle }} ↗</a>
                  <template v-else>{{ row.exec!.taskTitle }}</template>
                </span>
                <span
                  v-if="kindLabel(row.exec!)"
                  class="exec-kind"
                  :title="`Acción de la regla ${row.exec!.ruleId ?? ''}`"
                >{{ kindLabel(row.exec!) }}</span>
              </template>
              <!-- En un hijo NO cae al `ruleId`: la regla ya la dijo el resumen,
                   y repetirla en cada acción es lo que hacía parecer que la
                   notificación la había corrido el agente. Una acción inline no
                   tiene nombre y la columna queda vacía. -->
              <span class="exec-meta exec-agent">{{
                row.nested ? row.exec!.agentId : row.exec!.agentId || row.exec!.ruleId || ''
              }}</span>
              <span class="exec-meta exec-provider">{{ row.exec!.providerId }}</span>
              <span v-if="row.exec!.source" class="exec-meta exec-source" :title="`Corrió en: ${row.exec!.source}`">{{ row.exec!.source }}</span>
              <span
                v-if="row.exec!.cancelRequestedAt"
                class="exec-cancel-requested"
                :title="`Cancelación solicitada: ${row.exec!.cancelRequestedAt}`"
              >cancelación solicitada</span>
              <span class="exec-meta exec-date" :title="row.exec!.startedAt">{{ formatDateCompact(row.exec!.startedAt) }}</span>
              <span class="exec-meta exec-duration">{{ formatDuration(row.exec!.startedAt, row.exec!.finishedAt) }}</span>
              <span
                class="exec-outcome"
                :style="{
                  background: outcomeColor(row.exec!.outcome).bg,
                  color: outcomeColor(row.exec!.outcome).fg,
                }"
              >{{ outcomeLabel(row.exec!.outcome) }}</span>
              <span class="exec-chevron" aria-hidden="true">›</span>
            </button>
            <div class="exec-stop-slot">
              <button
                v-if="!row.exec!.finishedAt"
                type="button"
                class="exec-stop-btn"
                :disabled="isCancelling(row.exec!.id)"
                :data-testid="`executions-stop-${row.exec!.id}`"
                title="Detener ejecución"
                @click.stop="confirmCancelExecution(row.exec!)"
              >{{ isCancelling(row.exec!.id) ? '…' : '■ Detener' }}</button>
            </div>
          </div>
        </li>
      </template>
      </ul>
    </div>

    <div v-if="executions.length === limit" class="load-more">
      <button type="button" class="btn-secondary" :disabled="loading" @click="loadMore()">
        Cargar más
      </button>
    </div>

    <!-- Right-side detail drawer -->
    <transition name="exec-drawer">
      <aside
        v-if="selectedExec"
        class="exec-drawer"
        role="dialog"
        aria-label="Detalle de la ejecución"
        data-testid="executions-detail-drawer"
      >
        <header class="exec-drawer__header">
          <div class="exec-drawer__title">
            <h3>{{ isAction(selectedExec) ? 'Acción' : 'Ejecución' }}</h3>
            <span
              class="exec-outcome"
              :style="{
                background: outcomeColor(selectedExec.outcome).bg,
                color: outcomeColor(selectedExec.outcome).fg,
              }"
            >{{ outcomeLabel(selectedExec.outcome) }}</span>
            <span
              v-if="selectedExec.cancelRequestedAt"
              class="exec-cancel-requested"
              :title="`Cancelación solicitada: ${selectedExec.cancelRequestedAt}`"
            >cancelación solicitada</span>
          </div>
          <div class="exec-drawer__header-actions">
            <button
              v-if="!selectedExec.finishedAt"
              type="button"
              class="exec-stop-btn"
              :disabled="isCancelling(selectedExec.id)"
              data-testid="executions-detail-stop"
              @click="confirmCancelExecution(selectedExec)"
            >{{ isCancelling(selectedExec.id) ? 'Deteniendo…' : '■ Detener' }}</button>
            <button
              type="button"
              class="exec-drawer__close"
              aria-label="Cerrar detalle"
              data-testid="executions-detail-close"
              @click="closeDetail()"
            >×</button>
          </div>
        </header>

        <div
          ref="drawerBodyEl"
          class="exec-drawer__body"
          @scroll.passive="onDrawerScroll"
        >
          <p class="exec-drawer__task">
            <a
              v-if="issueUrlFor(selectedExec.taskId)"
              :href="issueUrlFor(selectedExec.taskId)!"
              target="_blank"
              rel="noopener noreferrer"
            >{{ selectedExec.taskTitle }} ↗</a>
            <template v-else>{{ selectedExec.taskTitle }}</template>
          </p>

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

          <div class="related-block">
            <div class="related-header">
              <span class="detail-label">
                {{ isAction(selectedExec) ? 'Líneas del daemon de esta regla' : 'Tool calls y eventos del servidor' }}
                <span
                  v-if="relatedLogs[selectedExec.id]"
                  class="related-count"
                >({{ relatedLogs[selectedExec.id].length }})</span>
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
                  Ir a Logs →
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
      </aside>
    </transition>
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
.exec-list-wrapper { position: relative; }
.exec-list-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 0.85rem;
  background: var(--panel-hi);
  border: 1px solid var(--border);
  border-radius: 6px 6px 0 0;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--fg-dim);
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
.exec-header-btn:hover { color: var(--fg); }
.exec-header-btn--active { color: var(--fg); }
.exec-list-header .exec-outcome-col {
  flex-shrink: 0;
  width: 90px;
  text-align: center;
}
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

.exec-card-inner { display: flex; align-items: stretch; }
.exec-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex: 1;
  min-width: 0;
  padding: 0.6rem 0.85rem;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: 0.85rem;
  color: var(--fg);
}
.exec-row:hover { background: var(--panel-alt); }

/* El resumen de un disparo de regla. Se dibuja como una fila normal —misma
   grilla, mismo outcome, misma altura— porque para escanear la lista ES la
   fila; lo único que la marca es el caret y un fondo apenas distinto. */
.exec-card--firing { background: var(--panel-alt); }
.exec-caret {
  display: inline-block;
  width: 0.9rem;
  flex-shrink: 0;
  color: var(--fg-dim);
  font-size: 0.75rem;
}
.exec-title--action { color: var(--fg-mute); display: flex; align-items: center; gap: 0.4rem; }
.exec-action-kind { font-size: 0.75rem; color: var(--fg-dim); }
.exec-project-tag--ghost { visibility: hidden; }

/* Una acción abierta desde el resumen de su disparo. El sangrado más la guía a
   la izquierda es lo que dice "esto lo lanzó aquella regla" — la regla es el
   padre de las dos, ninguna acción lo es de su hermana. */
.exec-card--nested { margin-left: 1.5rem; }
.exec-card--nested .exec-card-inner {
  border-left: 2px solid var(--border);
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

/* Qué corrió, cuando no fue un agente. Deliberadamente discreto: la fila
   importante de un disparo suele ser el run, no la notificación. */
.exec-kind {
  flex: 0 0 auto;
  padding: 0.05rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 0.7rem;
  color: var(--text-dim);
  text-transform: lowercase;
}
/* Reserved at a fixed width whether or not the button is rendered inside it,
   so `.exec-row`'s flex-basis stays identical across rows — otherwise rows
   with an active "Detener" button are narrower than finished rows and the
   fixed-width columns after the title (agent/provider/date/…) drift out of
   alignment with the sticky header. */
.exec-stop-slot {
  flex-shrink: 0;
  align-self: center;
  width: 84px;
  margin-right: 0.85rem;
  box-sizing: border-box;
}
.exec-stop-btn {
  width: 100%;
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
.exec-stop-spacer { flex-shrink: 0; width: 84px; }
.exec-drawer__header-actions { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
.exec-title { flex: 1; min-width: 0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.exec-title a { color: var(--accent); text-decoration: none; }
.exec-title a:hover { text-decoration: underline; }
/* Fixed column widths so header cells and row cells line up regardless of
   content length. Trimmed to the truncated-with-ellipsis floor (not the
   longest realistic value) so `.exec-title` — the one column people actually
   read — gets back the room these used to reserve for the rare long id. */
.exec-meta {
  font-size: 0.75rem;
  color: var(--fg-dim);
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.exec-project-tag {
  flex-shrink: 0;
  font-size: 0.7rem;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
  background: var(--yellow-bg);
  color: var(--warn);
  border: 1px solid var(--warn);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.exec-agent { font-family: 'SF Mono', 'Fira Code', monospace; color: var(--info); width: 140px; }
.exec-provider { font-family: 'SF Mono', 'Fira Code', monospace; width: 100px; }
.exec-source { font-family: 'SF Mono', 'Fira Code', monospace; color: var(--fg-dim); width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
.exec-date { font-variant-numeric: tabular-nums; width: 100px; font-family: 'SF Mono', 'Fira Code', monospace; }
.exec-duration { font-variant-numeric: tabular-nums; width: 70px; text-align: right; font-family: 'SF Mono', 'Fira Code', monospace; }
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
.exec-chevron { color: var(--fg-dim); font-size: 0.85rem; flex-shrink: 0; width: 14px; text-align: right; }

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

@media (max-width: 768px) {
  /* `.exec-row` es un flex sin `wrap` cuyos hijos no encogen: medía 477px
     dentro de una caja de 325. Envolver es lo correcto acá y no scrollear —a
     diferencia de la tabla del dashboard— porque una ejecución se lee como una
     ficha (agente, outcome, duración de ESE run), no comparando columnas entre
     filas. */
  /* Acá NO se envuelve, y el propio código dice por qué: las columnas tienen
     ancho fijo "so header cells and row cells line up". Envolver desalinea el
     header de las filas y rompe justo lo que hace legible la lista.
     
     Una tabla scrollea DENTRO de su caja: la página deja de moverse de lado y
     comparar columnas entre filas sigue siendo posible. El ancho mínimo sale
     de la suma de las columnas fijas más el spacer de 84px. */
  .exec-list-wrapper { overflow-x: auto; }
  .exec-list { min-width: 37rem; }
}
</style>