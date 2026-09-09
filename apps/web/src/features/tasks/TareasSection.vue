<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import TaskDetailModal from '@/features/tasks/TaskDetailModal.vue';
import { getRepoMappings, type DbRepoEntry } from '@/features/repos/api';
import { useProjectsStore } from '@/features/projects/store';
import { useDispositionsStore } from '@/features/tasks/dispositionsStore';
import FocusCard from '@/features/tasks/FocusCard.vue';
import { useFocusStore } from '@/features/tasks/focusStore';
import { useTaskGroupsStore } from '@/features/tasks/groupsStore';
import { sectionRows, type GroupedSection } from '@/features/tasks/task-grouping';
import ExecutionStatusLine from '@/components/ExecutionStatusLine.vue';
import ListBoardToggle from '@/components/ListBoardToggle.vue';
import ListControlsBar from '@/components/ListControlsBar.vue';
import BucketHeader from '@/components/BucketHeader.vue';
import TaskRow from '@/components/TaskRow.vue';
import KbdBar from '@/components/KbdBar.vue';
import { useDispositionOrder } from '@/composables/useDispositionOrder';
import { useIsSplit } from '@/composables/useIsMobile';
import { useNow } from '@/composables/useNow';
import { useResizableColumns } from '@/composables/useResizableColumns';
import {
  cancelTaskRun,
  fetchBlockersBatch,
  fetchTaskRunSummaries,
  requestSlackReview,
  runTaskNow,
} from '@/features/tasks/api';
import type {
  PullRequestRef,
  TaskDisposition,
  TaskRunSummary,
  RunTaskNowResult,
  SlackMemberRef,
  SlackReviewMessage,
} from '@ia-flow/shared';
import {
  ProjectSettingsSchema,
  resolveSlackReviewTarget,
  slackReviewBlockedReason,
} from '@ia-flow/shared';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import { useIntegrations } from '@/composables/useIntegrations';
import SlackReviewSettings from '@/features/tasks/SlackReviewSettings.vue';
import {
  fetchProjectItems,
  fetchProjectStatuses,
  setProjectItemField,
  type Blocker,
  type SourceItem,
} from '@/features/projects/sourceApi';
import { useToastStore } from '@/stores/toast';
import { useRoute, useRouter } from 'vue-router';
import TaskFiltersBar from '@/features/tasks/TaskFiltersBar.vue';
import {
  countActiveTaskFilters,
  EMPTY_TASK_FILTERS,
  filterTasks,
  taskFilterSummary,
  queryHasTaskFilters,
  taskFiltersFromQuery,
  taskFiltersFromSearch,
  taskFiltersToQuery,
  taskFiltersToSearch,
  type TaskFilters,
} from '@/features/tasks/taskFilters';

// UI-facing shape derived from SourceItem so the template doesn't have to
// dive into `meta` for provider-specific fields. Only GitHub populates
// issueNumber right now; other providers can extend the mapping later.
interface TaskRow {
  id: string
  title: string
  status: string
  issueNumber?: number
  repos: string
  /** Link al issue/item en la plataforma del provider. */
  url?: string
  /** Branch remota linkeada al item (Development panel en GitHub). */
  branch?: string
  branchUrl?: string
  pullRequests: PullRequestRef[]
  /** false ⇒ no sabemos si hay PRs; la UI no debe afirmar "Sin PR". */
  pullRequestsKnown: boolean
  /** El provider sabe hablar de ramas/PRs. False (p. ej. local-fs) ⇒ no
   * dibujamos la fila de dev links en vez de mentir con "sin rama". */
  hasDevLinks: boolean
  /** Hilo de Slack donde ya se pidió review, resuelto por el source. */
  slackThreadUrl?: string
  /** Logins asignados al issue, tal como los expone el provider. */
  assignees: string[]
  /** Repo dueño del issue, según el provider. No es lo que el operador declaró
   * en el board — es un hecho de la plataforma, y el último recurso para saber
   * de qué repo habla esta tarea. */
  repoName?: string
}


// El mismo tick que usa la línea de estado: la duración de un run vivo tiene
// que correr también en la columna de desktop.
const { now } = useNow();

const projectsStore = useProjectsStore();
const toastStore = useToastStore();

const projectItems = ref<TaskRow[]>([]);
const itemsLoading = ref(false);
const itemsError = ref('');
const blockersByTask = ref<Record<string, Blocker[]>>({});
// El último run de cada tarea. Vacío NO significa "ninguna corrió": mientras
// `runsKnown` sea false, la fila no afirma nada (ver ExecutionStatusLine).
const runsByTask = ref<Record<string, TaskRunSummary>>({});
const runsKnown = ref(false);
const reposModalOpen = ref(false);
const reposModalItem = ref<TaskRow | null>(null);

const repoEntries = ref<DbRepoEntry[]>([]);
const availableRepoNames = ref<string[]>([]);
// Sin Slack no hay botón de review en la tarjeta: el pedido fallaría con un 503
// y el operador no tendría dónde ver por qué. Los campos de config se apagan
// solos desde `SlackReviewFields`.
const { integrations } = useIntegrations();

const slackBusyId = ref<string | null>(null);
const runBusyId = ref<string | null>(null);
// Resultado del último "correr" de la tarea abierta. Se limpia al abrir el
// modal: un veredicto viejo sobre otra tarea sería peor que no mostrar nada.
const runResult = ref<RunTaskNowResult | null>(null);
const cancelBusyId = ref<string | null>(null);
const cancelConfirm = ref<TaskRow | null>(null);
const slackConfirm = ref<{ item: TaskRow; message: string } | null>(null);
const slackSettingsSaving = ref(false);

const activeProjectId = computed(() => projectsStore.activeProjectId);

// ─── Filtros del listado ─────────────────────────────────────────────────
//
// La URL manda: la ruta activa ya es `projects/:id/tareas`, así que el
// querystring nace scopeado por proyecto y una vista filtrada se comparte
// copiando el link. localStorage cubre sólo la entrada en frío (volver a la
// tab sin query), y por eso se guarda bajo una clave por proyecto: los
// statuses de uno no significan nada en otro.
const route = useRoute();
const router = useRouter();

/**
 * La tarea abierta vive en la URL como PATH PARAM (`:detailId`, compartido por
 * todas las tabs del proyecto — `projects/:id/:tab/:detailId?` en el router),
 * el mismo slot que ya usa ExecutionsSection para el detalle de un agente
 * (`pushDetailId`/`detailAgentId`). Antes era un `?taskId=` de query que sólo
 * se leía una vez en `onMounted`: no sobrevivía a "atrás" ni a abrir una
 * segunda tarea sin salir de la pestaña.
 */
const detailIdParam = computed<string | null>(() => {
  const id = route.params?.detailId;
  return typeof id === 'string' && id ? id : null;
});

/** `query: route.query` explícito: sin él, empujar sólo `params` resetea el
 *  querystring — y ahí viven los filtros activos de la lista. */
function pushDetailId(taskId: string | undefined): void {
  if (!route.name) return;
  const params = { ...route.params };
  if (taskId === undefined) delete params.detailId;
  else params.detailId = taskId;
  void router.push({ name: route.name, params, query: route.query });
}

const statusOptions = ref<string[]>([]);

/**
 * La última columna del pipeline **configurado** — no se infiere de las
 * tareas: un status que aparece en una tarea pero no está en `statusOptions`
 * no tiene posición conocida (podría ser `Blocked` o `Needs QA`, no
 * necesariamente el final), así que promoverlo a "terminal" por estar al
 * final de una lista inestable sería peor que no afirmar nada. `null` con
 * `statusOptions` vacío ⇒ ninguna tarea se marca.
 *
 * Es la columna que la fuente considera "terminada", sin adivinar por el
 * nombre — ver el comentario de `isClosed` en `GetTaskDispositionsUseCase`.
 * Sirve para distinguir, en el bullet de la fila, una tarea que YA está ahí
 * de una que nunca se tocó: la disposición no lo hace sola porque depende de
 * si el issue de GitHub está `closed`, no de en qué columna del board quedó.
 */
const terminalStatus = computed(() => statusOptions.value.at(-1) ?? null);
function isDoneInSource(item: TaskRow): boolean {
  if (!terminalStatus.value) return false;
  // Mismo criterio que `statusChips` (case-insensitive) y que `boardColumns`
  // (trim): un `Done` real no debe apagarse por un espacio o una mayúscula
  // que difiera entre la fuente y lo cacheado.
  return item.status.trim().toLowerCase() === terminalStatus.value.trim().toLowerCase();
}

function filtersStorageKey(projectId: string | null | undefined): string | null {
  return projectId ? `ia-flow:task-filters:${projectId}` : null;
}

function loadStoredFilters(projectId: string | null | undefined): TaskFilters {
  const key = filtersStorageKey(projectId);
  if (!key || typeof localStorage === 'undefined') return { ...EMPTY_TASK_FILTERS };
  try {
    return taskFiltersFromSearch(localStorage.getItem(key) ?? '');
  } catch {
    return { ...EMPTY_TASK_FILTERS };
  }
}

function storeFilters(projectId: string | null | undefined, value: TaskFilters) {
  const key = filtersStorageKey(projectId);
  if (!key || typeof localStorage === 'undefined') return;
  try {
    const search = taskFiltersToSearch(value);
    if (search) localStorage.setItem(key, search);
    else localStorage.removeItem(key);
  } catch {
    /* localStorage no disponible — la URL sigue siendo la fuente de verdad */
  }
}

const filters = ref<TaskFilters>(
  queryHasTaskFilters(route.query)
    ? taskFiltersFromQuery(route.query)
    : loadStoredFilters(activeProjectId.value),
);
// `blocked` no vive en `TaskRow` porque los blockers se resuelven aparte, por
// item y en paralelo (`loadBlockersFor`) — se inyecta acá, al momento de
// filtrar, en vez de bakearlo en `toRow` en frío.
const rowsWithBlocked = computed(() =>
  projectItems.value.map((item) => ({
    ...item,
    blocked: (blockersByTask.value[item.id]?.length ?? 0) > 0,
  })),
);
const filteredItems = computed(() => filterTasks(rowsWithBlocked.value, filters.value));

/** Lo que la barra de controles dibuja sin abrir nada: cuántos filtros hay y
 *  cuál es el que manda. Ver `taskFilters.ts` — la lógica es pura y se testea
 *  sin montar la sección. */
/**
 * El orden por disposición — el MISMO que Qué sigue, Board y Ejecuciones (O6).
 *
 * El orden por fecha (el que devuelve la fuente) queda como **opción**, no como
 * default: una fecha contesta *qué pasó*, y con agentes trabajando solos eso ya
 * no coincide con *qué me toca*. Lo que te espera es justamente lo que lleva
 * más tiempo quieto, o sea lo que un orden por fecha manda al fondo.
 */
/**
 * Las disposiciones viven en un store compartido: el badge de la tab bar
 * necesita el mismo dato, y `GET /api/tasks/dispositions` no es barato —por
 * debajo hace `getItems()` contra la fuente más los blockers de cada ítem—,
 * así que pedirlo dos veces al entrar a esta pantalla es rate limit de GitHub
 * gastado en el mismo número.
 */
const dispositionsStore = useDispositionsStore();
const dispositions = computed(() => dispositionsStore.entriesFor(activeProjectId.value));
/** El agregado no se pudo consultar: la lista cae al orden de la fuente y lo
 *  DICE, en vez de agrupar por buckets que no conoce. */
const dispositionsFailed = computed(() => dispositionsStore.hasFailed(activeProjectId.value));

/**
 * El criterio de orden de la lista — antes un toggle binario
 * (`groupByDisposition`), ahora un ciclo de 3 modos. Los 3 leen las MISMAS
 * `filteredItems`; lo único que cambia es cómo se cortan/ordenan:
 *
 * - `disposicion` (default): buckets + orden congelado (`useDispositionOrder`).
 * - `repo`: lista plana ordenada alfabéticamente por repo — para "¿qué tengo
 *   pendiente en tal repo?" sin tener que leer la columna de cada fila.
 * - `fuente`: lista plana en el orden que devuelve la fuente, sin tocar nada.
 *   Es el mismo comportamiento que antes tenía "por fecha" — el nombre
 *   cambió porque nunca ordenó por ninguna fecha real (`TaskRow` no trae
 *   `updatedAt`); esto era una etiqueta heredada, no una promesa incumplida
 *   nueva.
 */
const ORDER_MODES = ['disposicion', 'repo', 'fuente'] as const;
type OrderMode = (typeof ORDER_MODES)[number];
const orderMode = ref<OrderMode>('disposicion');
function cycleOrderMode(): void {
  const i = ORDER_MODES.indexOf(orderMode.value);
  orderMode.value = ORDER_MODES[(i + 1) % ORDER_MODES.length];
}

/**
 * El foco — la card de arriba. Store aparte del de disposiciones porque son
 * dos preguntas con costos distintos: aquél ordena la lista y esta pantalla no
 * se dibuja sin él; éste la comenta, tarda más (por debajo hay un modelo) y la
 * lista se dibuja completa sin esperarlo.
 */
const focusStore = useFocusStore();

/**
 * Los grupos por tema — sección opcional dentro del bucket `waiting-on-you`.
 *
 * Store aparte del de foco por el mismo motivo que el foco es aparte de las
 * disposiciones: es otra llamada a Haiku, con otro costo y otro interruptor
 * (`IA_FLOW_TASK_GROUPS`), y la lista se dibuja completa sin esperarla.
 */
const taskGroupsStore = useTaskGroupsStore();
/** Persistido por proyecto, igual patrón que `FocusCard`'s `STORAGE_PREFIX`. */
const GROUP_BY_TOPIC_PREFIX = 'tasks.groupByTopic.';
const groupByTopic = ref(true);
function readGroupByTopic(projectId: string | null): boolean {
  if (!projectId) return true;
  try {
    const raw = localStorage.getItem(GROUP_BY_TOPIC_PREFIX + projectId);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}
function setGroupByTopic(next: boolean): void {
  groupByTopic.value = next;
  const pid = activeProjectId.value;
  if (!pid) return;
  try {
    localStorage.setItem(GROUP_BY_TOPIC_PREFIX + pid, next ? '1' : '0');
  } catch {
    /* el agrupamiento es una conveniencia, no estado que haya que garantizar */
  }
}
watch(activeProjectId, (pid) => { groupByTopic.value = readGroupByTopic(pid); }, { immediate: true });
/** Sin grupos no hay nada que alternar: el toggle no se dibuja para no ser
 *  chrome que no cambia nada. */
const hasTaskGroups = computed(
  () => (taskGroupsStore.groupsFor(activeProjectId.value)?.groups.length ?? 0) > 0,
);
type BucketRowSection = GroupedSection<OrderedTask>;
/** Las filas de un bucket, cortadas en secciones. Sólo `waiting-on-you` se
 *  agrupa por tema; los demás buckets vuelven como una única sección suelta,
 *  que es exactamente el `<ul>` de siempre. */
function bucketSections(bucket: { disposition: TaskDisposition; rows: OrderedTask[] }): BucketRowSection[] {
  if (bucket.disposition !== 'waiting-on-you' || !groupByTopic.value) {
    return bucket.rows.length ? [{ kind: 'loose', rows: bucket.rows }] : [];
  }
  return sectionRows(bucket.rows, taskGroupsStore.groupsFor(activeProjectId.value));
}

/** Los títulos que la card necesita para sus picks. Salen de las filas que ya
 *  están en memoria: el foco viaja con ids, no con una segunda copia del
 *  título que pueda discrepar de la fila de abajo. */
const titlesById = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  for (const item of projectItems.value) out[item.id] = item.title;
  return out;
});

/**
 * La fila a la que te mandó un pick, marcada.
 *
 * Es una marca, no una selección persistente: se limpia al abrir cualquier
 * tarea, así que nunca hay dos filas en video inverso diciendo cosas distintas.
 */
const focusedTaskId = ref<string | null>(null);

function goToTask(taskId: string): void {
  focusedTaskId.value = taskId;
  // En el próximo tick: con la card recién colapsada, la fila todavía no está
  // en su posición final y el scroll caería en el lugar equivocado.
  void nextTick(() => {
    document
      .querySelector(`[data-task-id="${CSS.escape(taskId)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

const dispositionById = computed(
  () => new Map(dispositions.value.map((d) => [d.taskId, d])),
);

interface OrderedTask { id: string; disposition: TaskDisposition; item: TaskRow }

const orderedInput = computed<OrderedTask[]>(() => {
  const byId = dispositionById.value;
  // El orden de las filas lo trae el server ya resuelto; acá sólo se
  // intersecta con lo que el filtro dejó pasar.
  const visible = new Set(filteredItems.value.map((i) => i.id));
  const itemsById = new Map(filteredItems.value.map((i) => [i.id, i]));
  const out: OrderedTask[] = [];
  for (const d of dispositions.value) {
    if (!visible.has(d.taskId)) continue;
    // El chip acota a un bucket; sin chip, pasan los cuatro.
    if (quickFilter.value && d.disposition !== quickFilter.value) continue;
    const item = itemsById.get(d.taskId);
    if (item) out.push({ id: d.taskId, disposition: d.disposition, item });
  }
  // Una tarea que el agregado no conoce (recién creada) no desaparece del
  // listado: va al final, sin bucket que afirmar.
  for (const item of filteredItems.value) {
    if (byId.has(item.id)) continue;
    // Una tarea que el agregado no conoce no se afirma en ningún bucket, así
    // que un chip activo la esconde en vez de mentir sobre dónde está.
    if (quickFilter.value) continue;
    out.push({ id: item.id, disposition: 'waiting-on-you', item });
  }
  return out;
});

const { buckets, movedCount, freeze, freezeIfFirst, reset: resetOrder } =
  useDispositionOrder(orderedInput);

/** La lista plana que dibujan los modos `repo` y `fuente` (y el fallback de
 *  `disposicion` cuando el agregado falló). `repo` ordena; los demás modos
 *  dejan pasar `filteredItems` tal cual, que es exactamente el comportamiento
 *  que ya tenía "por fecha". */
const flatListItems = computed<TaskRow[]>(() => {
  if (orderMode.value !== 'repo') return filteredItems.value;
  return [...filteredItems.value].sort((a, b) =>
    (a.repoName ?? a.repos ?? '').localeCompare(b.repoName ?? b.repos ?? ''),
  );
});

/** `cerrado` arranca plegado (O4): es la parte del día que no hay que mirar. */
const closedOpen = ref(false);

/** Grupos de tema colapsados, por label. Arrancan todos abiertos —a
 *  diferencia de `cerrado`, un grupo de `waiting-on-you` sí es lo que hay
 *  que mirar; colapsar es una acción del usuario, no un default. */
const collapsedGroupLabels = ref<Set<string>>(new Set());
function toggleGroup(label: string): void {
  const next = new Set(collapsedGroupLabels.value);
  if (next.has(label)) next.delete(label);
  else next.add(label);
  collapsedGroupLabels.value = next;
}

/**
 * Los chips de filtro rápido: un toque para quedarte con un bucket.
 *
 * No son un segundo sistema de filtros — son un ATAJO sobre el que ya existe.
 * La pregunta "¿qué me toca?" se hace veinte veces por día y hoy costaba abrir
 * el panel y escribir un token; con el orden por disposición ya calculado, el
 * corte es gratis.
 *
 * **Un chip en cero no se dibuja** (R10): "0 bloqueadas" ocupa el mismo ancho
 * que un problema y no es uno. Y el activo es un toggle — volver a tocarlo
 * apaga, que es como se sale de un filtro sin buscar dónde.
 */
const QUICK_FILTERS: Array<{ key: TaskDisposition; label: string; glyph: string }> = [
  { key: 'waiting-on-you', label: 'me toca', glyph: '' },
  { key: 'blocked', label: 'bloqueadas', glyph: '⛔' },
  { key: 'moving', label: 'avanzando', glyph: '◐' },
];

const quickFilter = ref<TaskDisposition | null>(null);

/**
 * Lista o board — dos VISTAS de las mismas tareas, no dos pantallas.
 *
 * El board era un destino aparte, y eso obligaba a decidir por dónde entrar
 * antes de saber qué buscabas: las dos muestran el mismo conjunto, sólo que una
 * lo agrupa por status. La ruta `/board` sigue viva —los links viejos no se
 * rompen— y llega acá con la vista puesta.
 */
const props = withDefaults(defineProps<{ initialView?: 'lista' | 'board' }>(), {
  initialView: 'lista',
});
const view = ref<'lista' | 'board'>(props.initialView);
// El toggle navega (`/tareas` ↔ `/board`), y Vue REUSA el componente entre las
// dos rutas: sin este watch la vista se quedaría en la que se montó primero.
watch(() => props.initialView, (v) => { view.value = v; });

/**
 * El board: las MISMAS tareas, agrupadas por status en vez de por disposición.
 *
 * No es otra pantalla ni otra fila — es el mismo `TaskRow`, clickeable, con el
 * mismo detalle. Lo único que cambia es por qué se agrupa. Antes el board era
 * una sección aparte que redibujaba la fila por su cuenta, y la misma tarea se
 * leía distinta según desde dónde la miraras.
 *
 * Una columna por vez y no un carrusel: en un teléfono un board de cinco
 * columnas se lee scrolleando de lado y perdiendo el hilo.
 */
const activeStatus = ref<string | null>(null);

/** Anchos de las columnas de la vista tabla — el glifo (fijo) y el título
 *  (flexible, absorbe el resto) quedan afuera: sólo lo que el operador puede
 *  angostar/ensanchar arrastrando el encabezado. Mismo orden que el DOM de
 *  `.task-thead` y de `TaskRow` en `layout="table"` — ver `--tr-cols` ahí. */
const taskColumns = useResizableColumns('tasks', [
  { key: 'glyph', track: '16px' },
  { key: 'title', track: 'minmax(0, 1fr)' },
  { key: 'issue', defaultWidth: 54, minWidth: 40 },
  { key: 'state', defaultWidth: 100, minWidth: 60 },
  { key: 'agent', defaultWidth: 86, minWidth: 50 },
  { key: 'dur', defaultWidth: 54, minWidth: 40 },
]);

/** Ancho del panel de detalle sobre `--bp-split` — la lista es `1fr` y
 *  absorbe lo que sobra. `invert`: el handle vive en el borde IZQUIERDO del
 *  panel (a la derecha de la lista), así que arrastrar hacia la izquierda es
 *  lo que lo agranda. `26 * 18` porque el `rem` de la app es 18px, no 16. */
const splitColumns = useResizableColumns('tk-split', [
  { key: 'list', track: 'minmax(0, 1fr)' },
  { key: 'detail', defaultWidth: 26 * 18, minWidth: 320, maxWidth: 720, invert: true },
]);

const boardColumns = computed(() => {
  const counts = new Map<string, number>();
  for (const item of filteredItems.value) {
    const key = (item.status ?? '').trim();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // El orden lo da la fuente (`statusOptions`), que es el del pipeline; los que
  // aparecen en tareas pero no están configurados van al final en vez de
  // desaparecer — esconder una columna con tareas adentro es peor que
  // mostrarla fuera de orden.
  const ordered = statusOptions.value.filter((s) => counts.has(s));
  for (const s of counts.keys()) if (!ordered.includes(s)) ordered.push(s);
  return ordered.map((name) => ({ name, count: counts.get(name) ?? 0 }));
});

/** Sin elección explícita, la primera columna con tareas. */
const currentStatus = computed(
  () => activeStatus.value ?? boardColumns.value[0]?.name ?? null,
);

const columnItems = computed(() =>
  currentStatus.value
    ? filteredItems.value.filter((i) => (i.status ?? '').trim() === currentStatus.value)
    : [],
);

/** Sobre --bp-split el detalle deja de flotar y se vuelve la segunda columna. */
const { isSplit } = useIsSplit();

/**
 * Los props del detalle, en un solo lugar.
 *
 * El componente se monta dos veces —columna sobre `--bp-split`, overlay
 * debajo— y son veinte props: escribirlos dos veces garantiza que en el
 * próximo cambio uno de los dos quede viejo, y el que quede viejo va a ser el
 * que menos se mira.
 */
const detailProps = computed(() => {
  const item = reposModalItem.value;
  return {
    movingStatus: movingStatus.value,
    previewToken: previewToken.value,
    open: reposModalOpen.value,
    taskId: item?.id ?? null,
    projectId: activeProjectId.value ?? null,
    issueNumber: item?.issueNumber ?? 0,
    issueTitle: item?.title ?? '',
    repos: item ? currentReposOf(item) : [],
    issueUrl: item?.url,
    branch: item?.branch,
    branchUrl: item?.branchUrl,
    pullRequests: item?.pullRequests,
    devLinks: item?.hasDevLinks,
    pullRequestsKnown: item?.pullRequestsKnown,
    status: item?.status,
    running: runBusyId.value === item?.id,
    runResult: runResult.value,
    slackEnabled: integrations.value.slack.enabled,
    slackBlockedReason: item ? (slackBlockedReason(item) ?? null) : null,
    slackBusy: slackBusyId.value === item?.id,
    slackThreadUrl: item?.slackThreadUrl ?? null,
    execution: item ? (runsByTask.value[item.id]?.last ?? null) : null,
    attempts: item ? runsByTask.value[item.id]?.attempts : undefined,
    blocked: item ? (blockersByTask.value[item.id]?.length ?? 0) > 0 : false,
    runsKnown: runsKnown.value,
    cancelling: cancelBusyId.value === item?.id,
    // El orden de `statusOptions` ES el del pipeline (ver `boardColumns`):
    // es lo que convierte "qué hizo" en una barra de pasos en vez de una
    // lista plana.
    pipelineStatuses: statusOptions.value,
  };
});

const quickCounts = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {};
  for (const d of dispositions.value) {
    out[d.disposition] = (out[d.disposition] ?? 0) + 1;
  }
  return out;
});

const quickChips = computed(() =>
  QUICK_FILTERS.map((f) => ({ ...f, count: quickCounts.value[f.key] ?? 0 })).filter(
    (f) => f.count > 0,
  ),
);

function toggleQuickFilter(key: TaskDisposition) {
  quickFilter.value = quickFilter.value === key ? null : key;
}

/** La razón de cada fila, para dibujarla debajo del título (O1). */
function reasonFor(id: string): string {
  return dispositionById.value.get(id)?.reason ?? '';
}

async function loadDispositions() {
  const pid = activeProjectId.value;
  if (!pid) return;
  // El foco NO se espera: la lista se dibuja completa sin él, y su card
  // aparece después o no aparece. Sin `force` — a diferencia de las
  // disposiciones, que sí se re-piden al entrar: acá lo caro es el modelo, y
  // una inferencia de hace dos minutos sobre la misma lista sigue siendo
  // cierta (el server la cachea por huella del contenido, no por tiempo).
  void focusStore.fetch(pid);
  // Mismo trato que el foco: no se espera, no lleva `force`.
  void taskGroupsStore.fetch(pid);
  // `force`: entrar a Tareas es pedir el estado de ahora, no el de la última
  // vez que la tab bar lo consultó.
  await dispositionsStore.fetch(pid, { force: true });
  if (activeProjectId.value !== pid) return;
  freezeIfFirst();
}

/**
 * Mover la tarea al status que la sugerencia propone (`RunPreviewCard`).
 *
 * Lo ejecuta esta pantalla y no la card: el PATCH vive en la feature de
 * proyectos —una feature no importa el api de otra— y, sobre todo, quien mueve
 * la tarea es quien tiene que refrescar. Sin eso la tarea se movía de verdad y
 * la fila seguía mostrando el status viejo hasta un reload a mano.
 */
const movingStatus = ref<string | null>(null);
/**
 * Cuándo la preview del detalle tiene que volver a preguntar.
 *
 * Un CONTADOR, no el resultado de la última acción: dos "Correr ahora"
 * seguidos devuelven casi siempre lo mismo (`skipped`, mismo status — que es
 * justo cuando el operador reintenta), así que un token derivado del contenido
 * no cambiaba y la card se quedaba con el veredicto viejo. Se bumpea en cada
 * acción que puede cambiar ese veredicto: correr y mover.
 */
const previewToken = ref(0);
async function moveTaskTo(status: string): Promise<void> {
  const pid = activeProjectId.value;
  const item = reposModalItem.value;
  if (!pid || !item || movingStatus.value) return;
  movingStatus.value = status;
  try {
    await setProjectItemField(pid, item.id, 'status', status);
    toastStore.success(`Movida a ${status}`);
    await Promise.all([loadProjectItems(true), loadDispositions()]);
    // `loadProjectItems` reemplaza las filas por objetos NUEVOS, y el detalle
    // guarda una referencia a la vieja: sin re-apuntarla, la lista mostraba el
    // status nuevo y el detalle abierto seguía con el anterior.
    const fresh = projectItems.value.find((i) => i.id === item.id);
    if (fresh) {
      reposModalItem.value = fresh;
      previewToken.value += 1;
    } else {
      // El status destino puede caer fuera del filtro activo —que es el caso
      // normal al mover— y entonces la tarea ya no está en la lista. Dejar el
      // detalle abierto contra `null` lo deja en blanco: se cierra, que es lo
      // que la acción efectivamente hizo con ella en esta vista.
      closeReposModal();
      reposModalItem.value = null;
    }
  } catch (e) {
    toastStore.error(extractErrorMessage(e));
  } finally {
    movingStatus.value = null;
  }
}

const activeFilterCount = computed(() => countActiveTaskFilters(filters.value));
const filterSummary = computed(() => taskFilterSummary(filters.value));

// Un status seleccionado que el provider ya no lista sigue dibujándose: sin
// esto el chip desaparece y el operador no tiene cómo apagar el filtro que
// está escondiendo tareas.
const statusChips = computed<string[]>(() => {
  const chips = [...statusOptions.value];
  for (const s of filters.value.statuses) {
    if (!chips.some((c) => c.toLowerCase() === s.toLowerCase())) chips.push(s);
  }
  return chips;
});

// Igual criterio que `statusChips`: el universo sale de lo cargado (no hay
// endpoint que liste "los repos/assignees del board"), más lo ya
// seleccionado, para que un valor filtrado no desaparezca de la lista.
const repoChips = computed<string[]>(() => {
  const chips = new Set(availableRepoNames.value);
  for (const item of projectItems.value) {
    for (const r of item.repos.split(',').map((r) => r.trim()).filter(Boolean)) chips.add(r);
  }
  for (const r of filters.value.repos) chips.add(r);
  return [...chips].sort();
});

const assigneeChips = computed<string[]>(() => {
  const chips = new Set<string>();
  for (const item of projectItems.value) for (const a of item.assignees) chips.add(a);
  for (const a of filters.value.assignees) chips.add(a);
  return [...chips].sort();
});

watch(
  filters,
  (value) => {
    storeFilters(activeProjectId.value, value);
    const {
      status: _s,
      repo: _r,
      assigned: _a,
      pr: _p,
      rama: _rm,
      bloqueada: _bl,
      ...rest
    } = route.query;
    void router.replace({ query: { ...rest, ...taskFiltersToQuery(value) } });
  },
  { deep: true },
);

async function loadStatuses() {
  const pid = activeProjectId.value;
  if (!pid) {
    statusOptions.value = [];
    return;
  }
  try {
    const res = await fetchProjectStatuses(pid);
    statusOptions.value = (res.statuses ?? []).map((s) => s.name);
  } catch {
    // Sin statuses el eje no se dibuja; los otros filtros siguen sirviendo.
    statusOptions.value = [];
  }
}

function toRow(item: SourceItem): TaskRow {
  const meta = item.meta ?? {};
  const pullRequests = Array.isArray(meta.pullRequests)
    ? (meta.pullRequests as PullRequestRef[])
    : [];
  const branch = meta.linkedBranch as string | undefined;
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    issueNumber: meta.issueNumber as number | undefined,
    repos: item.repos ?? '',
    url: item.url ?? (meta.issueUrl as string | undefined),
    branch,
    branchUrl: meta.branchUrl as string | undefined,
    pullRequests,
    hasDevLinks: Array.isArray(meta.pullRequests) || branch !== undefined,
    pullRequestsKnown: meta.pullRequestsKnown !== false,
    slackThreadUrl: meta.slackThreadUrl as string | undefined,
    assignees: Array.isArray(meta.assignees) ? (meta.assignees as string[]) : [],
    repoName: meta.repoName as string | undefined,
  }
}

// ─── Pedido de review en Slack ───────────────────────────────────────────
//
// El gate se evalúa acá y no en el server para que el botón pueda decir POR QUÉ
// está apagado sin un round-trip por tarjeta. El server lo revalida igual: esto
// es UI, no autorización.

/** El PR abierto sobre el que se pide review — el primero, como en el engine. */
function openPr(item: TaskRow): PullRequestRef | undefined {
  return item.pullRequests.find((pr) => pr.state === 'open');
}

/** Motivo por el que NO se puede pedir review, o `undefined` si se puede. */
function slackBlockedReason(item: TaskRow): string | undefined {
  const pr = openPr(item);
  if (!pr) return 'La tarea no tiene ningún PR abierto';
  // Ausente = el PR no tiene checks: no hay CI que esperar.
  if (pr.ci === 'pending' || pr.ci === 'expected') return `El CI del PR #${pr.number} está corriendo`;
  return slackReviewBlockedReason(slackTargetFor(item));
}

function slackTargetFor(item: TaskRow) {
  const primary = currentReposOf(item)[0];
  const repo = primary
    ? repoEntries.value.find((r) => r.name === primary)
    : undefined;
  return resolveSlackReviewTarget(
    repo,
    ProjectSettingsSchema.partial().safeParse(projectsStore.activeProject?.settings ?? {}).data,
  );
}

async function loadRepoNames() {
  try {
    const entries = await getRepoMappings(activeProjectId.value ?? undefined);
    repoEntries.value = entries;
    availableRepoNames.value = [...new Set(entries.map((e) => e.name))].sort();
  } catch {
    /* non-fatal */
  }
}

async function loadProjectItems(refresh = false) {
  const pid = activeProjectId.value;
  if (!pid) {
    projectItems.value = [];
    itemsError.value = 'Selecciona un proyecto primero.';
    return;
  }
  itemsLoading.value = true;
  itemsError.value = '';
  try {
    const res = await fetchProjectItems(pid, { refresh });
    if (res.error) { itemsError.value = res.error; return; }
    projectItems.value = (res.items ?? []).map(toRow);
    // Dos requests para el listado entero, no dos por fila.
    void loadRunSummaries(pid);
    void loadBlockers(pid, projectItems.value.map((i) => i.id));
  } catch (e) {
    itemsError.value = extractErrorMessage(e);
  } finally {
    itemsLoading.value = false;
  }
}

/**
 * El último run de cada tarea, en una sola request.
 *
 * `runsKnown` recién se prende cuando la respuesta llegó: hasta entonces la
 * fila NO puede decir `sin ejecutar`, porque no sabe si corrió. Un fallo lo
 * deja apagado a propósito — el listado se ve sin línea de estado, que es
 * honesto, en vez de afirmar que nada corrió nunca.
 */
async function loadRunSummaries(projectId: string) {
  try {
    const summaries = await fetchTaskRunSummaries(projectId);
    // El operador pudo cambiar de proyecto mientras esto volaba: pisar con la
    // respuesta de otro proyecto mostraría runs que no son de estas tareas.
    if (activeProjectId.value !== projectId) return;
    const byTask: Record<string, TaskRunSummary> = {};
    for (const s of summaries) byTask[s.taskId] = s;
    runsByTask.value = byTask;
    runsKnown.value = true;
  } catch {
    if (activeProjectId.value === projectId) runsKnown.value = false;
  }
}

/**
 * Los blockers de todas las tareas visibles, en una sola request.
 *
 * Sólo se guardan los ids que el server devolvió: uno que no vino es "no se
 * pudo saber", y rellenarlo con `[]` sería afirmar que no está bloqueada.
 */
async function loadBlockers(projectId: string, ids: string[]) {
  if (!ids.length) return;
  try {
    const batch = await fetchBlockersBatch(projectId, ids);
    if (activeProjectId.value !== projectId) return;
    blockersByTask.value = batch;
  } catch {
    /* non-fatal: la fila simplemente no habla de bloqueos */
  }
}

function currentReposOf(item: TaskRow): string[] {
  const explicit = item.repos.split(',').map((r) => r.trim()).filter(Boolean);
  if (explicit.length) return explicit;
  // El campo "Repos" del board es manual y puede quedar sin llenar. Cuando lo
  // está, el repo se infiere de lo que la plataforma YA sabe, de lo más
  // específico a lo más general:
  //   1. el `headRepo` de sus PRs — puede ser otro repo que el del issue;
  //   2. el repo dueño del issue (`repoName`), que existe siempre.
  // Sin (2) una tarea sin PR todavía —el caso normal recién arrancada— decía
  // "sin repos" con su rama a la vista, y el board entero se veía sin repo.
  const fromPrs = [
    ...new Set(item.pullRequests.map((pr) => pr.headRepo).filter((r): r is string => !!r)),
  ];
  if (fromPrs.length) return fromPrs;
  return item.repoName ? [item.repoName] : [];
}

function openReposModal(item: TaskRow) {
  // Abrir una tarea apaga la marca del foco: dos filas en video inverso
  // diciendo cosas distintas es peor que ninguna.
  focusedTaskId.value = null;
  reposModalItem.value = item;
  runResult.value = null;
  reposModalOpen.value = true;
  // Si ya viene de sincronizar con la URL (`syncModalFromRoute`), el param ya
  // es este id — el guard evita un push redundante en ese camino.
  if (detailIdParam.value !== item.id) pushDetailId(item.id);
}

function closeReposModal(): void {
  reposModalOpen.value = false;
  if (detailIdParam.value !== null) pushDetailId(undefined);
}

/** Abre o cierra el modal para que coincida con `:detailId` — al montar, y en
 *  cada cambio posterior (atrás/adelante del navegador, o un link "Ver tarea"
 *  que cambia el param sin desmontar esta pantalla). */
function syncModalFromRoute(): void {
  const id = detailIdParam.value;
  if (!id) {
    if (reposModalOpen.value) reposModalOpen.value = false;
    return;
  }
  if (reposModalOpen.value && reposModalItem.value?.id === id) return;
  const item = projectItems.value.find((i) => i.id === id);
  if (item) {
    openReposModal(item);
  } else if (reposModalOpen.value) {
    // La URL apunta a una tarea que no está en esta página (filtrada por
    // status, o fuera del batch cargado): dejar el modal viejo abierto
    // mentiría sobre a qué tarea corresponde el id de la URL. No tocamos el
    // param — no sabemos si la tarea no existe o sólo no cargó todavía.
    reposModalOpen.value = false;
  }
}

async function onSlackReviewClick(item: TaskRow) {
  const pr = openPr(item);
  // Un CI en rojo no bloquea, pero tampoco sale solo: el revisor va a mirar un
  // PR que ya se sabe roto, y eso tiene que ser una decisión explícita.
  if (pr && (pr.ci === 'failure' || pr.ci === 'error')) {
    slackConfirm.value = {
      item,
      message: `El CI del PR #${pr.number} terminó en ${pr.ci}. ¿Pedir review igual?`,
    };
    return;
  }
  await doSlackReview(item, false);
}

async function doSlackReview(item: TaskRow, allowFailedCi: boolean) {
  if (!activeProjectId.value) return;
  slackBusyId.value = item.id;
  try {
    const res = await requestSlackReview(activeProjectId.value, item.id, { allowFailedCi });
    const who = res.reviewers.map((r) => r.name ?? r.id).join(', ');
    toastStore.success(
      res.kind === 're-review'
        ? `Re-review pedido en el hilo existente a ${who}`
        : `Review pedido a ${who}`,
    );
    if (res.threadNotPersisted) toastStore.error(`Aviso: ${res.threadNotPersisted}`);
    const idx = projectItems.value.findIndex((i) => i.id === item.id);
    if (idx !== -1 && res.threadUrl) {
      projectItems.value[idx] = { ...projectItems.value[idx], slackThreadUrl: res.threadUrl };
    }
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  } finally {
    slackBusyId.value = null;
  }
}

/** ¿Hay un PR abierto? Es lo que hace honesto el `sin PR` / `PR abierto` de la
 *  línea de estado — y sólo se pregunta cuando el provider modela PRs. */
function hasOpenPr(item: TaskRow): boolean {
  return item.pullRequests.some((pr) => pr.state === 'open');
}

/** La duración del último run, para la columna de desktop. `—` cuando no hay
 *  run: es una ausencia sabida, no un dato que falta. */
function durationOf(item: TaskRow): string {
  const last = runsByTask.value[item.id]?.last;
  if (!last) return runsKnown.value ? '—' : '';
  const ms =
    last.durationMs ??
    (last.finishedAt
      ? new Date(last.finishedAt).getTime() - new Date(last.startedAt).getTime()
      : now.value - new Date(last.startedAt).getTime());
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

/** Abrir los logs del último run de esta tarea, en la tab de ejecuciones con
 *  el run ya abierto (`?runId=` lo expande solo). */
function openLogs(item: TaskRow) {
  if (!activeProjectId.value) return;
  const runId = runsByTask.value[item.id]?.last.id;
  void router.push({
    path: `/projects/${activeProjectId.value}/executions`,
    ...(runId ? { query: { runId } } : {}),
  });
}

/**
 * Abortar el run en vuelo.
 *
 * Las cuatro ramas de la respuesta se dicen distinto porque son distintas —
 * sobre todo `cancelRequested`, donde el run vive en otro daemon y lo único
 * que se hizo fue avisarle: el contenedor sigue corriendo, y decir "abortado"
 * ahí sería mentir.
 */
async function doCancelRun(item: TaskRow) {
  const runId = runsByTask.value[item.id]?.last.id;
  if (!runId) return;
  cancelBusyId.value = item.id;
  try {
    const res = await cancelTaskRun(runId);
    if (res.cancelRequested) {
      toastStore.error('Pedido de aborto enviado al daemon dueño del run — sigue corriendo allá');
    } else if (res.alreadyFinished) {
      toastStore.success('El run ya había terminado');
    } else if (res.orphaned) {
      toastStore.success('Run huérfano cerrado');
    } else {
      toastStore.success('Run abortado');
    }
    if (activeProjectId.value) void loadRunSummaries(activeProjectId.value);
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  } finally {
    if (cancelBusyId.value === item.id) cancelBusyId.value = null;
  }
}

function confirmCancelRun() {
  const pending = cancelConfirm.value;
  cancelConfirm.value = null;
  if (pending) void doCancelRun(pending);
}

// ─── Correr una tarea a mano ─────────────────────────────────────────────
//
// La activación de un agente escucha `issue.created`/`issue.status_changed`, y
// una tarea que se queda quieta en su status no se vuelve a despachar sola —
// típico después de que un run se cancela, o cuando editás el issue y querés
// reintentar. Esto re-emite el status actual; el board no se toca.

async function onRunClick() {
  const item = reposModalItem.value;
  if (!item || !activeProjectId.value) return;
  runBusyId.value = item.id;
  runResult.value = null;
  // El modal puede haber cambiado de tarea mientras el pedido volaba (cerrar,
  // abrir otra). El veredicto es de ESTA tarea: pintarlo sobre otra es
  // exactamente lo que el reset de `openReposModal` intenta evitar.
  const isStillOpen = () => reposModalItem.value?.id === item.id;
  try {
    const res = await runTaskNow(activeProjectId.value, item.id);
    if (isStillOpen()) {
      runResult.value = res;
      previewToken.value += 1;
    }
    // Los tres outcomes son estados distintos y el operador tiene que poder
    // distinguirlos: "no matcheó ninguna regla" no es un error del server, es
    // config — y verlo como éxito sería peor que verlo como fallo. El detalle
    // del veredicto queda EN el modal (ver `runResult`); el toast es sólo para
    // el que cerró el modal enseguida.
    if (res.outcome === 'skipped') toastStore.error(`Ninguna regla matchea el status "${res.status}"`);
    else toastStore.success(res.outcome === 'deferred' ? 'En cola por capacidad' : `Corriendo (status ${res.status})`);
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  } finally {
    // El spinner también es de esta tarea: si ya hay otro pedido en vuelo
    // sobre otra, apagarlo sería apagar el de ella.
    if (runBusyId.value === item.id) runBusyId.value = null;
  }
}

async function saveSlackSettings(settings: {
  slackReviewChannel: string | null;
  slackReviewers: SlackMemberRef[] | null;
  slackReviewMessage: SlackReviewMessage | null;
}) {
  if (!activeProjectId.value) return;
  slackSettingsSaving.value = true;
  try {
    await projectsStore.update(activeProjectId.value, { settings });
    toastStore.success('Config de review actualizada');
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  } finally {
    slackSettingsSaving.value = false;
  }
}

function confirmSlackReview() {
  const pending = slackConfirm.value;
  slackConfirm.value = null;
  if (pending) void doSlackReview(pending.item, true);
}

onMounted(async () => {
  void loadRepoNames();
  void loadStatuses();
  void loadDispositions();
  // Await the initial load so we know whether el `:detailId` de la URL está
  // en la página cargada antes de decidir si el modal se abre solo (mismo
  // patrón que `?runId=` en ExecutionsSection, ahora sobre un path param).
  await loadProjectItems();
  // Ejecuciones → esta pestaña: `/tareas/<id>` pide aterrizar con esa tarea ya
  // abierta. Sin match, no-op en silencio — la tarea puede estar filtrada por
  // status o no venir en la página cargada.
  syncModalFromRoute();
});

// `:detailId` puede cambiar sin desmontar esta pantalla (atrás/adelante del
// navegador, o un segundo link "Ver tarea" mientras ya estás en Tareas) —
// `onMounted` sólo cubre el estado inicial.
watch(detailIdParam, syncModalFromRoute);

// Reload whenever the user switches projects — same pattern as StatusesSection.
// Los filtros se re-hidratan del storage del proyecto nuevo: los del anterior
// (y su querystring) hablan de statuses que acá no existen.
watch(activeProjectId, (pid) => {
  // Los agregados son del proyecto anterior: con `runsKnown` en true, las
  // filas del nuevo afirmarían `sin ejecutar` antes de saber nada — el "no sé
  // dibujado como no hay" que ExecutionStatusLine existe para evitar.
  runsByTask.value = {};
  blockersByTask.value = {};
  runsKnown.value = false;
  filters.value = loadStoredFilters(pid);
  // El orden congelado es del proyecto anterior: conservarlo dejaría las filas
  // del nuevo ordenadas por ids que no existen acá. Las disposiciones NO se
  // borran: el store las tiene por proyecto, así que volver es gratis.
  resetOrder();
  // Los labels son un cómputo del proyecto anterior: uno colapsado acá
  // escondería, por coincidencia de nombre, un grupo del proyecto nuevo que
  // nadie plegó.
  collapsedGroupLabels.value = new Set();
  void loadRepoNames();
  void loadStatuses();
  void loadProjectItems();
  void loadDispositions();
});
</script>

<template>
  <section class="settings-section settings-section--list">
    <!-- El `<h2>Tareas del proyecto</h2>` y su descripción se borraron (R9,
         R12): la barra de identidad del shell ya dice el proyecto y la sección,
         y el párrafo describía lo que la lista muestra abajo. Lo único del
         header que informaba —el conteo y Actualizar— entra en la fila de
         controles, que ya está ahí. -->
    <ListControlsBar
      :filter-count="activeFilterCount"
      :summary="filterSummary ?? undefined"
      title="Filtrar tareas"
      @clear="filters = { ...EMPTY_TASK_FILTERS }"
    >
      <template #view>
        <!-- Board es la misma lista agrupada por status: su entrada vive acá,
             no como un destino más de la navegación. -->
        <ListBoardToggle
          :project-id="activeProjectId ?? null"
          :view="view"
          :board-available="statusOptions.length > 0"
        />
      </template>

      <!-- Los controles que dan forma a la lista: en la fila cuando hay ancho,
           dentro del sheet cuando no. Seis controles en 390px daban 199px de
           scroll horizontal (R2). -->
      <template #tools>
        <span v-if="projectItems.length" class="task-count" data-testid="task-count">
          {{ filteredItems.length }} de {{ projectItems.length }} tareas
        </span>
        <!-- Disposición sigue siendo el default: agentes trabajando solos
             hacen que "¿qué me toca?" ya no coincida con ningún orden de
             fecha. Repo y fuente quedan como OPCIONES, un click más allá. -->
        <button
          type="button"
          class="lcb-order"
          :class="{ 'is-on': orderMode === 'disposicion' }"
          :disabled="dispositionsFailed"
          :aria-pressed="orderMode === 'disposicion'"
          :title="dispositionsFailed
            ? 'No se pudo consultar la disposición de las tareas'
            : orderMode === 'disposicion'
              ? 'Agrupado por quién mueve la próxima pieza — tocá para ordenar por repo'
              : orderMode === 'repo'
                ? 'Ordenado por repo — tocá para ver el orden de la fuente'
                : 'Orden de la fuente — tocá para agrupar por disposición'"
          data-testid="tareas-order-toggle"
          @click="cycleOrderMode"
        >{{ orderMode === 'disposicion' ? 'por disposición' : orderMode === 'repo' ? 'por repo' : 'de la fuente' }}</button>
        <!-- Sólo tiene sentido agrupando por disposición: agrupar por tema
             DENTRO de un orden por fecha mezclaría dos criterios a la vez. -->
        <button
          v-if="orderMode === 'disposicion' && hasTaskGroups"
          type="button"
          class="lcb-order"
          :class="{ 'is-on': groupByTopic }"
          :aria-pressed="groupByTopic"
          :title="groupByTopic
            ? 'Te espera agrupado por tema — tocá para ver la lista suelta'
            : 'Lista suelta — tocá para agrupar por tema'"
          data-testid="tareas-group-by-topic-toggle"
          @click="setGroupByTopic(!groupByTopic)"
        >{{ groupByTopic ? 'agrupado por tema' : 'sin agrupar' }}</button>
        <button
          type="button"
          class="lcb-refresh"
          :disabled="itemsLoading"
          :aria-label="itemsLoading ? 'Cargando' : 'Actualizar'"
          :title="itemsLoading ? 'Cargando…' : 'Actualizar'"
          @click="loadProjectItems(true); loadDispositions()"
        >{{ itemsLoading ? '◐' : '↺' }}</button>
      </template>

      <TaskFiltersBar
        v-model="filters"
        :statuses="statusChips"
        :repos="repoChips"
        :assignees="assigneeChips"
      />
    </ListControlsBar>

    <!-- La vista de board: las MISMAS tareas y la MISMA fila, agrupadas por
         status en vez de por disposición. Lo único que cambia es el criterio;
         la fila es `TaskRow`, clickeable, con el mismo detalle. -->
    <div
      class="tk-split"
      :class="{ 'tk-split--open': isSplit && reposModalOpen }"
      :style="{ '--split-cols': splitColumns.gridTemplateColumns.value, '--split-detail-w': `${splitColumns.widths.detail}px` }"
    >
      <div
        v-if="isSplit && reposModalOpen"
        class="split-resize-handle"
        title="Arrastrar para cambiar el ancho"
        @pointerdown="splitColumns.startResize('detail', $event)"
      ></div>
    <div class="tk-list" :style="{ '--tr-cols': taskColumns.gridTemplateColumns.value }">
    <template v-if="view === 'board'">
      <div v-if="boardColumns.length" class="bd-chips">
        <button
          v-for="col in boardColumns"
          :key="col.name"
          type="button"
          class="bd-chip"
          :class="{ 'is-on': col.name === currentStatus }"
          :aria-pressed="col.name === currentStatus"
          :data-testid="`board-chip-${col.name}`"
          @click="activeStatus = col.name"
        >{{ col.name }} <b>{{ col.count }}</b></button>
      </div>

      <p v-if="!boardColumns.length" class="repos-empty">
        Ninguna tarea tiene status: no hay columnas que mostrar.
      </p>

      <!-- `data-kbd-list` es lo que `useKeyboardNav` busca con `closest`: sin
           él la KbdBar de abajo anunciaría atajos que no hacen nada. -->
      <div v-else class="task-table" data-kbd-list="tasks">
        <BucketHeader
          v-if="currentStatus"
          disposition="moving"
          :count="columnItems.length"
          :label-override="currentStatus"
        />
        <TaskRow
          v-for="item in columnItems"
          :key="item.id"
          layout="table"
          :selected="reposModalItem?.id === item.id"
          :title="item.title"
          :issue-number="item.issueNumber"
          :issue-url="item.url"
          :reason="reasonFor(item.id)"
          :disposition="dispositionById.get(item.id)?.disposition"
          :execution="runsByTask[item.id]?.last ?? null"
          :attempts="runsByTask[item.id]?.attempts"
          :blocked="(blockersByTask[item.id]?.length ?? 0) > 0"
          :runs-known="runsKnown"
          :pull-requests-known="item.pullRequestsKnown"
          :has-open-pr="hasOpenPr(item)"
          :agent="runsByTask[item.id]?.last.agentId"
          :duration="durationOf(item)"
          @open="openReposModal(item)"
        />
        <KbdBar />
      </div>

      <p class="bd-note">
        Arrastrar entre columnas no existe acá: el status se cambia desde el detalle de la tarea.
      </p>
    </template>

    <template v-else>
    <!-- Atajos de una tocada sobre la disposición: la pregunta "¿qué me toca?"
         se hace veinte veces por día y no debería costar abrir un panel. Un
         chip en cero no se dibuja (R10). -->
    <div v-if="quickChips.length && orderMode === 'disposicion'" class="quick-chips">
      <button
        v-for="chip in quickChips"
        :key="chip.key"
        type="button"
        class="quick-chip"
        :class="[`quick-chip--${chip.key}`, { 'is-on': quickFilter === chip.key }]"
        :aria-pressed="quickFilter === chip.key"
        :data-testid="`quick-filter-${chip.key}`"
        @click="toggleQuickFilter(chip.key)"
      >
        <span v-if="chip.glyph" class="quick-chip__glyph" aria-hidden="true">{{ chip.glyph }}</span>
        {{ chip.label }}
        <b>{{ chip.count }}</b>
      </button>
    </div>

    <SlackReviewSettings
      :project="projectsStore.activeProject"
      :saving="slackSettingsSaving"
      @save="saveSlackSettings"
    />

    <!-- Error como lo pide el design system: la línea del proceso y, debajo,
         la accion que lo resuelve. -->
    <div v-if="itemsError" class="items-error">
      <p class="items-error-line"><span class="items-error-glyph">✕</span>{{ itemsError }}</p>
      <p class="items-error-fix"><span class="items-error-glyph">→</span>Revisa el provider del proyecto y vuelve a intentar con Actualizar.</p>
    </div>

    <div v-else-if="itemsLoading && !projectItems.length" class="repos-empty">
      Cargando tareas…
    </div>

    <div v-else-if="!projectItems.length" class="repos-empty">
      No hay tareas para este proyecto.
    </div>

    <!-- Vacío por filtro ≠ vacío de verdad: el operador tiene que poder
         distinguir "no hay tareas" de "las escondí yo". -->
    <div v-else-if="!filteredItems.length" class="repos-empty">
      Ninguna de las {{ projectItems.length }} tareas coincide con los filtros activos.
    </div>

    <!-- El orden no se recalcula solo: si lo hiciera, la fila que ibas a tocar
         se movería bajo el dedo con cada evento del socket. -->
    <button
      v-else-if="movedCount > 0 && orderMode === 'disposicion'"
      type="button"
      class="tk-moved"
      data-testid="tareas-reorder"
      @click="freeze"
    >
      {{ movedCount }} {{ movedCount === 1 ? 'cambió' : 'cambiaron' }} de lugar
      <span class="tk-moved-sep">·</span>
      <span class="tk-moved-cta">reordenar</span>
    </button>

    <template v-if="filteredItems.length">
    <!-- El foco va entre el chrome y el primer bucket, y NUNCA expandido a la
         vez que el aviso de reorden: dos cosas pidiendo atención arriba de la
         lista empujan la primera fila fuera de la pantalla. -->
    <FocusCard
      v-if="orderMode === 'disposicion' && !dispositionsFailed"
      :project-id="activeProjectId"
      :focus="focusStore.focusFor(activeProjectId)"
      :loading="focusStore.isLoading(activeProjectId)"
      :failed="focusStore.hasFailed(activeProjectId)"
      :waiting-count="quickCounts['waiting-on-you'] ?? 0"
      :titles="titlesById"
      :crowded="movedCount > 0"
      @go="goToTask"
      @retry="focusStore.fetch(activeProjectId, { force: true })"
    />

    <!-- Sin el agregado la lista NO inventa buckets: cae al orden de la fuente
         y lo dice. Agrupar por una disposición que no se pudo consultar sería
         afirmar en qué bucket está cada tarea sin haber preguntado. -->
    <p v-if="dispositionsFailed" class="tk-degraded">
      No se pudo consultar el estado de las tareas: se listan en el orden de la fuente.
    </p>

    <div class="task-table">
      <!-- Encabezado sólo en desktop: en mobile la fila se apila y una
           cabecera de columnas no describiría nada. -->
      <div class="task-thead">
        <span aria-hidden="true"></span>
        <span aria-hidden="true">tarea</span>
        <span class="task-th-col">
          <span class="task-th-label">issue</span>
          <span class="col-resize-handle" title="Arrastrar para cambiar el ancho" @pointerdown="taskColumns.startResize('issue', $event)"></span>
        </span>
        <span class="task-th-col">
          <span class="task-th-label">ejecución</span>
          <span class="col-resize-handle" title="Arrastrar para cambiar el ancho" @pointerdown="taskColumns.startResize('state', $event)"></span>
        </span>
        <span class="task-th-col">
          <span class="task-th-label">agente</span>
          <span class="col-resize-handle" title="Arrastrar para cambiar el ancho" @pointerdown="taskColumns.startResize('agent', $event)"></span>
        </span>
        <span class="task-th-dur task-th-col">
          <span class="task-th-label">dur.</span>
          <span class="col-resize-handle" title="Arrastrar para cambiar el ancho" @pointerdown="taskColumns.startResize('dur', $event)"></span>
        </span>
      </div>

      <template v-for="bucket in (orderMode === 'disposicion' && !dispositionsFailed ? buckets : [])" :key="bucket.disposition">
        <BucketHeader
          :disposition="bucket.disposition"
          :count="bucket.rows.length"
          :collapsible="bucket.disposition === 'closed'"
          :open="closedOpen"
          @toggle="closedOpen = !closedOpen"
        />
        <template v-if="bucket.disposition !== 'closed' || closedOpen">
          <template
            v-for="(section, si) in bucketSections(bucket)"
            :key="`${bucket.disposition}-${si}`"
          >
            <!-- Sub-encabezado del grupo: reusa `BucketHeader` (labelOverride
                 lo pone en su variante neutral) desplazado un renglón para no
                 pisar el encabezado del bucket, que también es sticky. -->
            <BucketHeader
              v-if="section.kind === 'group'"
              disposition="waiting-on-you"
              :count="section.rows.length"
              :label-override="section.label"
              collapsible
              :open="!collapsedGroupLabels.has(section.label)"
              style="top: calc(var(--tap-h) + 26px)"
              @toggle="toggleGroup(section.label)"
            />
            <ul
              v-if="section.kind !== 'group' || !collapsedGroupLabels.has(section.label)"
              class="task-list"
              data-kbd-list="tasks"
            >
              <TaskRow
                v-for="row in section.rows"
                :key="row.id"
                layout="table"
                :data-task-id="row.id"
                :selected="reposModalItem?.id === row.id || focusedTaskId === row.id"
                :title="row.item.title"
                :issue-number="row.item.issueNumber"
                :issue-url="row.item.url"
                :reason="reasonFor(row.id)"
                :disposition="row.disposition"
                :execution="runsByTask[row.id]?.last ?? null"
                :attempts="runsByTask[row.id]?.attempts"
                :blocked="(blockersByTask[row.id]?.length ?? 0) > 0"
                :runs-known="runsKnown"
                :pull-requests-known="row.item.pullRequestsKnown"
                :has-open-pr="hasOpenPr(row.item)"
                :agent="runsByTask[row.id]?.last.agentId"
                :duration="durationOf(row.item)"
                :done-in-source="isDoneInSource(row.item)"
                @open="openReposModal(row.item)"
              />
            </ul>
          </template>
        </template>
      </template>

      <ul
        v-if="orderMode !== 'disposicion' || dispositionsFailed"
        class="task-list"
        data-kbd-list="tasks"
      >
        <TaskRow
          v-for="item in flatListItems"
          :key="item.id"
          layout="table"
          :selected="reposModalItem?.id === item.id"
          :title="item.title"
          :issue-number="item.issueNumber"
          :issue-url="item.url"
          :execution="runsByTask[item.id]?.last ?? null"
          :attempts="runsByTask[item.id]?.attempts"
          :blocked="(blockersByTask[item.id]?.length ?? 0) > 0"
          :runs-known="runsKnown"
          :pull-requests-known="item.pullRequestsKnown"
          :has-open-pr="hasOpenPr(item)"
          :agent="runsByTask[item.id]?.last.agentId"
          :duration="durationOf(item)"
          :done-in-source="isDoneInSource(item)"
          @open="openReposModal(item)"
        />
      </ul>

      <!-- Los atajos, al pie de la lista que gobiernan. Sólo los que existen.
           Sin link de escape: ya estás en el listado completo. -->
      <KbdBar />
    </div>
    </template>

    </template>
    </div>
    <!-- Sobre --bp-split el detalle es una COLUMNA hermana, no un overlay: la
         lista queda entera y usable, que es lo que permite recorrer varias
         tareas seguidas. Debajo del breakpoint sigue siendo el panel lateral
         de siempre, y bajo --bp-shell la pantalla completa. -->
    <TaskDetailModal
      v-if="isSplit"
      inline
      v-bind="detailProps"
      @logs="reposModalItem && openLogs(reposModalItem)"
      @cancel-run="cancelConfirm = reposModalItem"
      @slack-review="reposModalItem && onSlackReviewClick(reposModalItem)"
      @run="onRunClick"
      @move="moveTaskTo"
      @close="closeReposModal"
    />
    </div>
  </section>

  <!-- Abortar corta trabajo real: siempre detrás de una confirmación. -->
  <ConfirmDialog
    :open="!!cancelConfirm"
    title="Abortar el run"
    :message="`Se corta el run en vuelo de «${cancelConfirm?.title ?? ''}». Lo que el agente haya dejado sin commitear queda en su worktree.`"
    confirm-label="Abortar"
    danger
    @confirm="confirmCancelRun"
    @cancel="cancelConfirm = null"
  />

  <ConfirmDialog
    :open="!!slackConfirm"
    title="CI en rojo"
    :message="slackConfirm?.message ?? ''"
    confirm-label="Pedir review igual"
    danger
    @confirm="confirmSlackReview"
    @cancel="slackConfirm = null"
  />

  <!-- Debajo de --bp-split, el overlay de siempre. Mismos props que la
       columna: `detailProps` existe para que no diverjan. -->
  <TaskDetailModal
    v-if="!isSplit"
    v-bind="detailProps"
    @logs="reposModalItem && openLogs(reposModalItem)"
    @cancel-run="cancelConfirm = reposModalItem"
    @slack-review="reposModalItem && onSlackReviewClick(reposModalItem)"
    @run="onRunClick"
    @move="moveTaskTo"
    @close="closeReposModal"
  />
</template>

<style scoped>
/* El aviso de reorden: información, no alarma — describe el estado del ORDEN,
   no el de una tarea. Misma pieza que en Qué sigue. */
.tk-moved {
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
.tk-moved:hover { background: var(--panel-hi); }
.tk-moved-sep { color: var(--fg-dimmer); }
.tk-moved-cta { text-decoration: underline; }

/* Degradación, no error: las tareas llegaron, su disposición no. */
.tk-degraded { margin: 0 0 0.4rem; font-size: var(--fs-body-sm); color: var(--warn); }

/* La razón (O1) ocupa la celda de ejecución: es la misma pregunta contestada
   mejor, no un dato de más. El color viene de su disposición — el único en
   --danger es el que pide algo tuyo. */
.task-row-reason {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-row-reason.is-waiting-on-you { color: var(--danger); }
.task-row-reason.is-blocked { color: var(--warn); }
.task-row-reason.is-moving { color: var(--accent); }
.task-row-reason.is-closed { color: var(--fg-dimmer); }

/* ── La segunda columna (--bp-split) ──────────────────────────────────────
   Hasta 1100px la lista ocupa todo y el detalle flota encima. Arriba, se
   parten: lista a la izquierda y detalle a la derecha, hermanos en la misma
   grilla.

   La grilla sólo aparece CON el detalle abierto (`--open`): sin él, reservar
   26rem vacías dejaría la lista angosta para nada. Y la transición es de
   `grid-template-columns`, así que la lista se acomoda en vez de saltar.

   El ancho del panel sale de `--split-cols` (mismo patrón que `--tr-cols` /
   `--rr-cols`): `useResizableColumns` lo escribe, el handle lo arrastra. */
.tk-split { display: flex; flex-direction: column; min-width: 0; position: relative; }
.tk-list { min-width: 0; }

@media (min-width: 1100px) {
  .tk-split--open {
    display: grid;
    grid-template-columns: var(--split-cols, minmax(0, 1fr) 26rem);
    gap: 1rem;
    align-items: start;
  }
  /* `position: absolute` para no contar como un tercer ítem de la grilla —
     la grilla sólo declara dos tracks (lista, detalle). Ancla al borde
     IZQUIERDO del panel: `right` cuenta desde el borde derecho del split, así
     que alcanza con el ancho del panel + la mitad del `gap`, sin necesidad de
     saber cuánto mide la lista. */
  .split-resize-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    right: calc(var(--split-detail-w, 26rem) + 0.5rem);
    width: 0.65rem;
    cursor: col-resize;
    touch-action: none;
    z-index: 2;
  }
  .split-resize-handle::after {
    content: '';
    position: absolute;
    top: 10%;
    left: 50%;
    width: 1px;
    height: 80%;
    background: var(--border-hi);
  }
  .split-resize-handle:hover::after { background: var(--accent); }
}

/* Los chips del board: una columna por vez, no un carrusel horizontal. En un
   teléfono un board de cinco columnas se lee scrolleando de lado y perdiendo
   el hilo. Misma caja que los chips de filtro rápido — son el mismo gesto. */
.bd-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 0.5rem;
}
.bd-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4ch;
  height: var(--tap-h-sm);
  padding: 0 0.7rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-chrome);
  cursor: pointer;
  white-space: nowrap;
}
.bd-chip:hover { border-color: var(--border-hi); }
/* El activo en video inverso, como toda selección del sistema. */
.bd-chip.is-on { background: var(--accent); border-color: var(--accent); color: var(--panel); }

.bd-note {
  margin: 0.5rem 0 0;
  font-size: var(--fs-micro);
  color: var(--fg-dimmer);
}

/* Los chips de filtro rápido. `--tap-h-sm`: son chips que van en fila y su
   destino es ancho — la medida del chip que NAVEGA, no la del que decora. */
.quick-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 0.5rem;
}
.quick-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4ch;
  height: var(--tap-h-sm);
  padding: 0 0.7rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-chrome);
  cursor: pointer;
  white-space: nowrap;
}
.quick-chip:hover { border-color: var(--border-hi); }
/* El activo en video inverso, como toda selección del sistema. */
.quick-chip.is-on { background: var(--accent); border-color: var(--accent); color: var(--panel); }
.quick-chip__glyph { color: var(--fg-dim); }
.quick-chip.is-on .quick-chip__glyph { color: var(--panel); }
/* El único con color propio es el que pide algo tuyo. */
.quick-chip--waiting-on-you { border-color: var(--danger); color: var(--danger); }
.quick-chip--waiting-on-you.is-on {
  background: var(--danger);
  border-color: var(--danger);
  color: var(--panel);
}

/* El conteo y Actualizar viven en la fila de controles desde que el header de
   sección se borró: son lo único que ese header informaba. */
.lcb-order {
  flex: 0 0 auto;
  height: var(--tap-h-sm);
  padding: 0 0.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  white-space: nowrap;
  cursor: pointer;
}
.lcb-order.is-on { border-color: var(--accent); color: var(--accent); }
.lcb-order:disabled { opacity: 0.5; cursor: not-allowed; }

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

/* El contador va pegado a Actualizar porque responde a la misma pregunta que
   ese botón: qué estoy viendo, y de cuánto. */
.task-count {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  white-space: nowrap;
}
.btn-glyph { color: var(--fg-dim); }
.btn:hover:not(:disabled) .btn-glyph { color: var(--accent); }

.repos-empty { font-size: var(--fs-body-sm); color: var(--fg-dim); padding: 0.5rem 0; }
.items-error {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  background: var(--red-bg);
  font-family: var(--font-mono);
  font-size: var(--fs-chrome);
  line-height: var(--row-h);
}
.items-error-line { margin: 0; color: var(--danger); overflow-wrap: anywhere; }
.items-error-fix { margin: 0; color: var(--info); }
.items-error-glyph { display: inline-block; width: 1.4ch; }


/* ─── La fila de una tarea ────────────────────────────────────────────────
   Dos formas de la MISMA fila, no dos componentes: apilada en mobile
   (glifo · [título + issue] / línea de estado) y en una línea en desktop
   (tarea · issue · ejecución · agente · duración). El breakpoint es el que la
   app ya usa (768px, el del drawer del sidebar). */

.task-table {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  /* `clip` y NO `hidden`, y la diferencia es funcional.
     `overflow: hidden` convierte a la caja en un contenedor de scroll, y un
     `position: sticky` de adentro pasa a anclarse a ELLA en vez de a la
     página. Como la tabla no scrollea, el encabezado de bucket quedaba clavado
     a 44px de su borde superior — tapando la primera fila para siempre, no
     mientras scrolleabas.
     `clip` recorta igual (que es lo único que se quería, para el radio) pero
     NO crea contenedor de scroll, así que el sticky vuelve a mirar la página. */
  overflow: clip;
}
.task-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

/* Encabezado de columnas: no existe en mobile, donde la fila se apila. */
.task-thead { display: none; }

.task-row {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  grid-template-areas:
    'glyph title issue'
    'glyph exec  exec';
  gap: 0.2rem 0.55rem;
  align-items: baseline;
  padding: 0.55rem 0.9rem;
  background: var(--panel);
  cursor: pointer;
}
/* Zebra: la separación entre filas densas la da la superficie, no un borde
   más — con hairline Y zebra la lista se lee como una grilla de Excel. */
.task-row:nth-child(even) { background: var(--panel-alt); }
.task-row + .task-row { border-top: 1px solid var(--border-mute); }
.task-row:hover { background: var(--panel-hi); }

.task-row-glyph {
  grid-area: glyph;
  display: flex;
  /* El glifo se alinea con la PRIMERA línea del título, que puede envolver. */
  align-items: baseline;
}
/* El glifo de la columna 1 es la misma línea de estado con el texto oculto:
   una sola implementación del vocabulario, no un segundo mapa de glifos que
   pueda divergir. */
.task-row-glyph-only :deep(.esl-text) { display: none; }

.task-row-title {
  grid-area: title;
  min-width: 0;
  font-size: var(--fs-body);
  line-height: 1.4;
  color: var(--fg);
  /* Envuelve, NUNCA trunca: el final de un título es lo que distingue una
     fila de otra. */
  text-wrap: pretty;
  overflow-wrap: anywhere;
}

.task-row-issue {
  grid-area: issue;
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dimmer);
  text-decoration: none;
  white-space: nowrap;
}
/* Sin esto el `a:hover` global lo pinta de teal entero (trampa conocida). */
.task-row-issue:hover:not(.is-plain) { background: transparent; color: var(--info); }
.task-row-issue.is-plain { cursor: default; }

.task-row-exec { grid-area: exec; }
/* En mobile el agente y la duración viven dentro de la línea de estado. */
.task-row-agent,
.task-row-dur { display: none; }

@media (min-width: 768px) {
  .task-thead,
  .task-row {
    display: grid;
    /* Mismo `--tr-cols` que `TaskRow.vue` en `layout="table"` — declarado acá
       (ver `taskColumns` / `:style` en `.tk-list`) para que el encabezado y
       cada fila midan siempre lo mismo sin escribirlo dos veces. */
    grid-template-columns: var(--tr-cols, 16px minmax(0, 1fr) 7ch 13ch 11ch 7ch);
    grid-template-areas: none;
    gap: 0.65rem;
    align-items: center;
    padding: 0 0.65rem;
  }
  /* Sin esto las celdas siguen reclamando las áreas con nombre del layout
     apilado: como acá no existen, el grid las auto-ubica y las filas se
     superponen. En una línea el orden de columnas ES el del template. */
  .task-row-glyph,
  .task-row-title,
  .task-row-issue,
  .task-row-exec {
    grid-area: auto;
  }
  .task-thead {
    height: calc(var(--row-h) * 1.05);
    background: var(--panel-hi);
    border-bottom: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    letter-spacing: var(--tracking-hd);
    text-transform: uppercase;
    color: var(--fg-dim);
  }
  .task-th-dur { text-align: right; }

  /* La celda del encabezado necesita `relative` para anclar el handle a su
     borde derecho — que es EXACTAMENTE el borde de la columna que arrastra,
     no el del `gap` de al lado. `min-width: 0` es lo que deja angostar la
     celda por debajo del ancho de su contenido: sin él, un grid item mide
     como mínimo su `min-content`, así que angostar la columna no hacía nada
     y el handle sólo se llevaba puesto el próximo arrastre. */
  .task-th-col { position: relative; min-width: 0; }
  /* La etiqueta trunca ANTES de desbordar sobre la columna vecina — sin esto
     un handle en su mínimo dejaba el texto pintado encima de "agente" en vez
     de cortado, y parecía que el arrastre movía la columna equivocada. */
  .task-th-label {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .col-resize-handle {
    position: absolute;
    top: 0;
    right: -0.65rem;
    width: 0.65rem;
    height: 100%;
    cursor: col-resize;
    /* Sin esto un arrastre en touch scrollea la lista en vez de mover la
       columna — mismo motivo que `useDragReorder` en su handle. */
    touch-action: none;
  }
  .col-resize-handle::after {
    content: '';
    position: absolute;
    top: 15%;
    left: 50%;
    width: 1px;
    height: 70%;
    background: var(--border-hi);
  }
  .col-resize-handle:hover::after { background: var(--accent); }

  .task-row {
    height: calc(var(--row-h) * 1.2);
  }
  .task-row-title {
    font-size: var(--fs-body-sm);
    /* Acá SÍ trunca: la fila mide una línea, y la alternativa es una tabla que
       salta de alto entre filas. El título completo sigue en el `title` y en
       el detalle. */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* El glifo ya está en la columna 1: repetirlo en la columna de ejecución
     sería decir dos veces lo mismo en la misma fila. */
  .task-row-exec :deep(.esl-glyph),
  .task-row-exec :deep(.esl-live) { display: none; }

  .task-row-agent,
  .task-row-dur {
    display: block;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    color: var(--fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task-row-dur { text-align: right; }
}
</style>
