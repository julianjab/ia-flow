<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { computed, onMounted, ref, watch } from 'vue';
import TaskDetailModal from '@/features/tasks/TaskDetailModal.vue';
import { getRepoMappings, type DbRepoEntry } from '@/features/repos/api';
import { useProjectsStore } from '@/features/projects/store';
import ExecutionStatusLine from '@/components/ExecutionStatusLine.vue';
import ListBoardToggle from '@/components/ListBoardToggle.vue';
import ListControlsBar from '@/components/ListControlsBar.vue';
import BucketHeader from '@/components/BucketHeader.vue';
import { useDispositionOrder } from '@/composables/useDispositionOrder';
import { useNow } from '@/composables/useNow';
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
  TaskDispositionEntry,
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
  type Blocker,
  type SourceItem,
} from '@/features/projects/sourceApi';
import { useToastStore } from '@/stores/toast';
import { useRoute, useRouter } from 'vue-router';
import TaskFiltersBar from '@/features/tasks/TaskFiltersBar.vue';
import { fetchTaskDispositions } from '@/features/tasks/api';
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

const statusOptions = ref<string[]>([]);

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
const dispositions = ref<TaskDispositionEntry[]>([]);
/** El agregado no se pudo consultar: la lista cae al orden de la fuente y lo
 *  DICE, en vez de agrupar por buckets que no conoce. */
const dispositionsFailed = ref(false);
const groupByDisposition = ref(true);

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
    const item = itemsById.get(d.taskId);
    if (item) out.push({ id: d.taskId, disposition: d.disposition, item });
  }
  // Una tarea que el agregado no conoce (recién creada) no desaparece del
  // listado: va al final, sin bucket que afirmar.
  for (const item of filteredItems.value) {
    if (!byId.has(item.id)) out.push({ id: item.id, disposition: 'waiting-on-you', item });
  }
  return out;
});

const { buckets, movedCount, freeze, freezeIfFirst, reset: resetOrder } =
  useDispositionOrder(orderedInput);

/** `cerrado` arranca plegado (O4): es la parte del día que no hay que mirar. */
const closedOpen = ref(false);

/** La razón de cada fila, para dibujarla debajo del título (O1). */
function reasonFor(id: string): string {
  return dispositionById.value.get(id)?.reason ?? '';
}

async function loadDispositions() {
  const pid = activeProjectId.value;
  if (!pid) return;
  dispositionsFailed.value = false;
  try {
    const next = await fetchTaskDispositions(pid);
    if (activeProjectId.value !== pid) return;
    dispositions.value = next;
    freezeIfFirst();
  } catch {
    if (activeProjectId.value !== pid) return;
    dispositionsFailed.value = true;
    dispositions.value = [];
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
  reposModalItem.value = item;
  runResult.value = null;
  reposModalOpen.value = true;
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
    if (isStillOpen()) runResult.value = res;
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

onMounted(() => {
  void loadRepoNames();
  void loadStatuses();
  void loadProjectItems();
  void loadDispositions();
});

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
  // del nuevo ordenadas por ids que no existen acá.
  dispositions.value = [];
  resetOrder();
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
          view="lista"
          :board-available="statusOptions.length > 0"
        />
        <span v-if="projectItems.length" class="task-count" data-testid="task-count">
          {{ filteredItems.length }} de {{ projectItems.length }} tareas
        </span>
        <!-- El orden por fecha queda como OPCIÓN, no como default: una fecha
             contesta *qué pasó*, y con agentes trabajando solos eso dejó de
             coincidir con *qué me toca*. Pero sigue siendo el orden correcto
             para "¿qué se movió hoy?", así que no se borra. -->
        <button
          type="button"
          class="lcb-order"
          :class="{ 'is-on': groupByDisposition }"
          :disabled="dispositionsFailed"
          :aria-pressed="groupByDisposition"
          :title="dispositionsFailed
            ? 'No se pudo consultar la disposición de las tareas'
            : groupByDisposition
              ? 'Agrupado por quién mueve la próxima pieza — tocá para ver el orden de la fuente'
              : 'Orden de la fuente — tocá para agrupar por disposición'"
          data-testid="tareas-order-toggle"
          @click="groupByDisposition = !groupByDisposition"
        >{{ groupByDisposition ? 'por disposición' : 'por fecha' }}</button>
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
      v-else-if="movedCount > 0 && groupByDisposition"
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
    <!-- Sin el agregado la lista NO inventa buckets: cae al orden de la fuente
         y lo dice. Agrupar por una disposición que no se pudo consultar sería
         afirmar en qué bucket está cada tarea sin haber preguntado. -->
    <p v-if="dispositionsFailed" class="tk-degraded">
      No se pudo consultar el estado de las tareas: se listan en el orden de la fuente.
    </p>

    <div class="task-table">
      <!-- Encabezado sólo en desktop: en mobile la fila se apila y una
           cabecera de columnas no describiría nada. -->
      <div class="task-thead" aria-hidden="true">
        <span></span><span>tarea</span><span>issue</span><span>ejecución</span><span>agente</span>
        <span class="task-th-dur">dur.</span>
      </div>

      <template v-for="bucket in (groupByDisposition && !dispositionsFailed ? buckets : [])" :key="bucket.disposition">
        <BucketHeader
          :disposition="bucket.disposition"
          :count="bucket.rows.length"
          :collapsible="bucket.disposition === 'closed'"
          :open="closedOpen"
          @toggle="closedOpen = !closedOpen"
        />
        <ul
          v-if="bucket.disposition !== 'closed' || closedOpen"
          class="task-list"
          data-kbd-list="tasks"
        >
          <li
            v-for="row in bucket.rows"
            :key="row.id"
            class="task-row"
            data-kbd-item
            tabindex="0"
            @click="openReposModal(row.item)"
          >
            <span class="task-row-glyph">
              <ExecutionStatusLine
                class="task-row-glyph-only"
                :execution="runsByTask[row.id]?.last ?? null"
                :attempts="runsByTask[row.id]?.attempts"
                :blocked="(blockersByTask[row.id]?.length ?? 0) > 0"
                :runs-known="runsKnown"
                :pull-requests-known="row.item.pullRequestsKnown"
                :has-open-pr="hasOpenPr(row.item)"
              />
            </span>
            <span class="task-row-title" :title="row.item.title">{{ row.item.title }}</span>
            <a
              v-if="row.item.issueNumber && row.item.url"
              class="task-row-issue"
              :href="row.item.url"
              target="_blank"
              rel="noopener"
              :title="`Abrir #${row.item.issueNumber} en el provider`"
              @click.stop
            >#{{ row.item.issueNumber }}</a>
            <span v-else-if="row.item.issueNumber" class="task-row-issue is-plain">#{{ row.item.issueNumber }}</span>
            <span v-else class="task-row-issue is-plain"></span>
            <!-- La razón OCUPA la columna de ejecución, no se suma a ella (O1).
                 Las dos contestaban lo mismo y se pisaban: la fila decía
                 `sin ejecutar` dos veces y el título perdía la mitad de su
                 ancho. La razón gana porque es un superconjunto — la arma el
                 server y ya trae lo que la línea de ejecución decía
                 (`PR #1233 · CI ✓ · traba 4 tareas`) más el porqué de que te
                 toque a vos (`no hay regla de retry`), que es justamente lo
                 que la línea de estado no puede saber.

                 Sin disposición (el agregado no se pudo consultar) vuelve la
                 línea de siempre: es mejor decir el estado que no decir nada. -->
            <span
              v-if="reasonFor(row.id)"
              class="task-row-exec task-row-reason"
              :class="`is-${row.disposition}`"
              :title="reasonFor(row.id)"
            >{{ reasonFor(row.id) }}</span>
            <ExecutionStatusLine
              v-else
              class="task-row-exec"
              :execution="runsByTask[row.id]?.last ?? null"
              :attempts="runsByTask[row.id]?.attempts"
              :blocked="(blockersByTask[row.id]?.length ?? 0) > 0"
              :runs-known="runsKnown"
              :pull-requests-known="row.item.pullRequestsKnown"
              :has-open-pr="hasOpenPr(row.item)"
            />
            <span class="task-row-agent">{{ runsByTask[row.id]?.last.agentId ?? '—' }}</span>
            <span class="task-row-dur">{{ durationOf(row.item) }}</span>
          </li>
        </ul>
      </template>

      <ul
        v-if="!groupByDisposition || dispositionsFailed"
        class="task-list"
        data-kbd-list="tasks"
      >
        <li
          v-for="item in filteredItems"
          :key="item.id"
          class="task-row"
          data-kbd-item
          tabindex="0"
          @click="openReposModal(item)"
        >
          <span class="task-row-glyph">
            <ExecutionStatusLine
              class="task-row-glyph-only"
              :execution="runsByTask[item.id]?.last ?? null"
              :attempts="runsByTask[item.id]?.attempts"
              :blocked="(blockersByTask[item.id]?.length ?? 0) > 0"
              :runs-known="runsKnown"
              :pull-requests-known="item.pullRequestsKnown"
              :has-open-pr="hasOpenPr(item)"
            />
          </span>

          <span class="task-row-title" :title="item.title">{{ item.title }}</span>

          <a
            v-if="item.issueNumber && item.url"
            class="task-row-issue"
            :href="item.url"
            target="_blank"
            rel="noopener"
            :title="`Abrir #${item.issueNumber} en el provider`"
            @click.stop
          >#{{ item.issueNumber }}</a>
          <span v-else-if="item.issueNumber" class="task-row-issue is-plain">#{{ item.issueNumber }}</span>
          <span v-else class="task-row-issue is-plain"></span>

          <!-- La misma línea en las dos resoluciones: en mobile ocupa la
               segunda fila del bloque de texto; en desktop, la columna
               `ejecución`. Una sola implementación del vocabulario. -->
          <ExecutionStatusLine
            class="task-row-exec"
            :execution="runsByTask[item.id]?.last ?? null"
            :attempts="runsByTask[item.id]?.attempts"
            :blocked="(blockersByTask[item.id]?.length ?? 0) > 0"
            :runs-known="runsKnown"
            :pull-requests-known="item.pullRequestsKnown"
            :has-open-pr="hasOpenPr(item)"
          />

          <span class="task-row-agent">{{ runsByTask[item.id]?.last.agentId ?? '—' }}</span>
          <span class="task-row-dur">{{ durationOf(item) }}</span>
        </li>
      </ul>
    </div>
    </template>
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

  <TaskDetailModal
    :open="reposModalOpen"
    :task-id="reposModalItem?.id ?? null"
    :project-id="activeProjectId ?? null"
    :issue-number="reposModalItem?.issueNumber ?? 0"
    :issue-title="reposModalItem?.title ?? ''"
    :repos="reposModalItem ? currentReposOf(reposModalItem) : []"
    :issue-url="reposModalItem?.url"
    :branch="reposModalItem?.branch"
    :branch-url="reposModalItem?.branchUrl"
    :pull-requests="reposModalItem?.pullRequests"
    :dev-links="reposModalItem?.hasDevLinks"
    :pull-requests-known="reposModalItem?.pullRequestsKnown"
    :status="reposModalItem?.status"
    :running="runBusyId === reposModalItem?.id"
    :run-result="runResult"
    :slack-enabled="integrations.slack.enabled"
    :slack-blocked-reason="reposModalItem ? (slackBlockedReason(reposModalItem) ?? null) : null"
    :slack-busy="slackBusyId === reposModalItem?.id"
    :slack-thread-url="reposModalItem?.slackThreadUrl ?? null"
    :execution="reposModalItem ? (runsByTask[reposModalItem.id]?.last ?? null) : null"
    :attempts="reposModalItem ? runsByTask[reposModalItem.id]?.attempts : undefined"
    :blocked="reposModalItem ? (blockersByTask[reposModalItem.id]?.length ?? 0) > 0 : false"
    :runs-known="runsKnown"
    :cancelling="cancelBusyId === reposModalItem?.id"
    @logs="reposModalItem && openLogs(reposModalItem)"
    @cancel-run="cancelConfirm = reposModalItem"
    @slack-review="reposModalItem && onSlackReviewClick(reposModalItem)"
    @run="onRunClick"
    @close="reposModalOpen = false"
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
  overflow: hidden;
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
    grid-template-columns: 16px minmax(0, 1fr) 7ch 13ch 11ch 7ch;
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
