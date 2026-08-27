<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { computed, onMounted, ref, watch } from 'vue';
import ItemReposModal from '@/features/repos/ItemReposModal.vue';
import { getRepoMappings, type DbRepoEntry } from '@/features/repos/api';
import { useProjectsStore } from '@/features/projects/store';
import { requestSlackReview } from '@/features/tasks/api';
import type { PullRequestRef, SlackMemberRef, SlackReviewMessage } from '@ia-flow/shared';
import {
  ProjectSettingsSchema,
  resolveSlackReviewTarget,
  slackReviewBlockedReason,
} from '@ia-flow/shared';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import SlackReviewSettings from '@/features/tasks/SlackReviewSettings.vue';
import TaskTags from '@/components/TaskTags.vue';
import {
  fetchItemBlockers,
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
  EMPTY_TASK_FILTERS,
  filterTasks,
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
}


const projectsStore = useProjectsStore();
const toastStore = useToastStore();

const projectItems = ref<TaskRow[]>([]);
const itemsLoading = ref(false);
const itemsError = ref('');
const blockersByTask = ref<Record<string, Blocker[]>>({});
const blockersLoading = ref<Record<string, boolean>>({});
const reposModalOpen = ref(false);
const reposModalItem = ref<TaskRow | null>(null);
const reposModalSaving = ref(false);

const repoEntries = ref<DbRepoEntry[]>([]);
const availableRepoNames = ref<string[]>([]);
const slackBusyId = ref<string | null>(null);
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
const filteredItems = computed(() => filterTasks(projectItems.value, filters.value));

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

watch(
  filters,
  (value) => {
    storeFilters(activeProjectId.value, value);
    const { status: _s, pr: _p, branch: _b, merged: _m, ...rest } = route.query;
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
    // Fire off blocker fetches in parallel; each item card renders when its
    // request lands. Failures per item are non-fatal — just leave blockers empty.
    for (const item of projectItems.value) {
      void loadBlockersFor(pid, item.id);
    }
  } catch (e) {
    itemsError.value = extractErrorMessage(e);
  } finally {
    itemsLoading.value = false;
  }
}

async function loadBlockersFor(projectId: string, itemId: string) {
  blockersLoading.value = { ...blockersLoading.value, [itemId]: true };
  try {
    const res = await fetchItemBlockers(projectId, itemId);
    if (res.error) return;
    blockersByTask.value = { ...blockersByTask.value, [itemId]: res.blockers ?? [] };
  } catch {
    /* non-fatal */
  } finally {
    blockersLoading.value = { ...blockersLoading.value, [itemId]: false };
  }
}

function currentReposOf(item: TaskRow): string[] {
  return item.repos.split(',').map((r) => r.trim()).filter(Boolean);
}

function openReposModal(item: TaskRow) {
  reposModalItem.value = item;
  reposModalOpen.value = true;
}

async function handleReposSave(repos: string[]) {
  if (!reposModalItem.value || !activeProjectId.value) return;
  reposModalSaving.value = true;
  try {
    // Providers own how they persist a repos field — the source registry
    // (github.setProjectTextField, future linear.setIssueField, …) resolves
    // the right write path from the project row.
    await setProjectItemField(
      activeProjectId.value,
      reposModalItem.value.id,
      'Repos',
      repos.join(', '),
    );
    const idx = projectItems.value.findIndex((i) => i.id === reposModalItem.value!.id);
    if (idx !== -1) projectItems.value[idx] = { ...projectItems.value[idx], repos: repos.join(', ') };
    reposModalOpen.value = false;
    toastStore.success('Repos actualizados');
  } catch (e) {
    toastStore.error(`Error: ${extractErrorMessage(e)}`);
  } finally {
    reposModalSaving.value = false;
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
});

// Reload whenever the user switches projects — same pattern as StatusesSection.
// Los filtros se re-hidratan del storage del proyecto nuevo: los del anterior
// (y su querystring) hablan de statuses que acá no existen.
watch(activeProjectId, (pid) => {
  filters.value = loadStoredFilters(pid);
  void loadRepoNames();
  void loadStatuses();
  void loadProjectItems();
});
</script>

<template>
  <section class="settings-section">
    <div class="section-header">
      <div class="section-head-text">
        <h2>Tareas del proyecto</h2>
        <p class="section-desc">
          Items del provider de este proyecto. Haz click en una tarea para editar sus
          <strong>repos</strong>.
        </p>
      </div>
      <div class="section-head-actions">
        <span v-if="projectItems.length" class="task-count" data-testid="task-count">
          {{ filteredItems.length }} de {{ projectItems.length }} tareas
        </span>
        <button type="button" class="btn" :disabled="itemsLoading" @click="loadProjectItems(true)">
          <span class="btn-glyph">{{ itemsLoading ? '◐' : '↺' }}</span>
          {{ itemsLoading ? 'Cargando…' : 'Actualizar' }}
        </button>
      </div>
    </div>

    <SlackReviewSettings
      :project="projectsStore.activeProject"
      :saving="slackSettingsSaving"
      @save="saveSlackSettings"
    />

    <TaskFiltersBar v-model="filters" :statuses="statusChips" />

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

    <ul v-else class="task-list" data-kbd-list="tasks">
      <li
        v-for="item in filteredItems"
        :key="item.id"
        class="task-card"
        data-kbd-item
        tabindex="0"
        @click="openReposModal(item)"
      >
        <div class="task-card-main">
          <a
            v-if="item.issueNumber && item.url"
            class="task-number task-number-link"
            :href="item.url"
            target="_blank"
            rel="noopener"
            :title="`Abrir #${item.issueNumber} en el provider`"
            @click.stop
          >#{{ item.issueNumber }}<span class="task-number-glyph">↗</span></a>
          <span v-else-if="item.issueNumber" class="task-number">#{{ item.issueNumber }}</span>
          <span class="task-title" :title="item.title">{{ item.title }}</span>
          <span v-if="item.status" class="task-status-chip">{{ item.status }}</span>
          <span
            v-if="(blockersByTask[item.id]?.length ?? 0) > 0"
            class="task-blocked-badge"
            :title="`Bloqueada por ${blockersByTask[item.id]!.length} issue(s) sin finalizar`"
          ><span class="task-blocked-glyph">⛔</span>{{ blockersByTask[item.id]!.length }}</span>
        </div>
        <div v-if="(blockersByTask[item.id]?.length ?? 0) > 0" class="task-blockers">
          <span class="uc-label">Bloqueada por</span>
          <a
            v-for="b in blockersByTask[item.id]"
            :key="b.id"
            :href="b.url ?? '#'"
            :class="['task-blocker-chip', { 'is-plain': !b.url }]"
            :target="b.url?.startsWith('http') ? '_blank' : undefined"
            :rel="b.url?.startsWith('http') ? 'noopener' : undefined"
            :title="b.title"
            @click.stop
          >
            <span class="task-blocker-ref">{{ b.ref ?? b.id }}</span>
            <span v-if="b.title" class="task-blocker-title">{{ b.title }}</span>
            <span v-if="b.status" class="task-blocker-status">· {{ b.status }}</span>
          </a>
        </div>
        <div class="task-card-foot">
          <TaskTags
            :repos="currentReposOf(item)"
            :branch="item.branch"
            :branch-url="item.branchUrl"
            :pull-requests="item.pullRequests"
            :dev-links="item.hasDevLinks"
            :pull-requests-known="item.pullRequestsKnown"
            :slack-thread-url="item.slackThreadUrl"
            show-empty-repos
          />
          <button
            v-if="item.hasDevLinks"
            type="button"
            class="btn btn--ghost task-slack-btn"
            :disabled="!!slackBlockedReason(item) || slackBusyId === item.id"
            :title="slackBlockedReason(item) ?? 'Taguea a los reviewers del repo en su canal de Slack'"
            @click.stop="onSlackReviewClick(item)"
          >
            <span class="btn-glyph">{{ slackBusyId === item.id ? '◐' : '✦' }}</span>
            {{ item.slackThreadUrl ? 'Pedir re-review' : 'Solicitar review' }}
          </button>
        </div>
      </li>
    </ul>
  </section>

  <ConfirmDialog
    :open="!!slackConfirm"
    title="CI en rojo"
    :message="slackConfirm?.message ?? ''"
    confirm-label="Pedir review igual"
    danger
    @confirm="confirmSlackReview"
    @cancel="slackConfirm = null"
  />

  <ItemReposModal
    :open="reposModalOpen"
    :issue-number="reposModalItem?.issueNumber ?? 0"
    :issue-title="reposModalItem?.title ?? ''"
    :current-repos="reposModalItem ? currentReposOf(reposModalItem) : []"
    :available-repos="availableRepoNames"
    :saving="reposModalSaving"
    :issue-url="reposModalItem?.url"
    :branch="reposModalItem?.branch"
    :branch-url="reposModalItem?.branchUrl"
    :pull-requests="reposModalItem?.pullRequests"
    :dev-links="reposModalItem?.hasDevLinks"
    :pull-requests-known="reposModalItem?.pullRequestsKnown"
    @close="reposModalOpen = false"
    @save="handleReposSave"
  />
</template>

<style scoped>
.settings-section {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  padding: 1rem;
}
.section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.9rem;
}
.section-head-text { min-width: 0; }
.section-head-actions { display: flex; align-items: center; gap: 0.6rem; flex: 0 0 auto; }
/* El contador va pegado a Actualizar porque responde a la misma pregunta que
   ese botón: qué estoy viendo, y de cuánto. */
.task-count {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  white-space: nowrap;
}
/* h1–h6 ya son --font-display / 700 por theme.css: acá sólo la caja alta y el
   tracking que pide el patrón "header de sección". */
.settings-section h2 {
  margin: 0;
  font-size: var(--fs-body);
  text-transform: uppercase;
  letter-spacing: var(--tracking-hd);
}
.section-desc {
  margin: 0.25rem 0 0;
  font-size: var(--fs-chrome);
  color: var(--fg-dim);
  line-height: 1.5;
}
.btn-glyph { color: var(--fg-dim); }
.btn:hover:not(:disabled) .btn-glyph { color: var(--accent); }

.repos-empty { font-size: var(--fs-body-sm); color: var(--fg-dim); padding: 0.5rem 0; }

.task-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
.task-card {
  border: 1px solid var(--border);
  border-left: 2px solid var(--border-mute);
  border-radius: var(--radius-sm);
  padding: 0.45rem 0.7rem;
  background: var(--panel);
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  cursor: pointer;
}
.task-card:hover { background: var(--panel-hi); border-left-color: var(--info); }

.task-card-main {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  min-width: 0;
  min-height: var(--row-h);
}
/* El número nunca encoge ni se parte: es el ancla de lectura de la fila. */
.task-number {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  color: var(--fg-dim);
  white-space: nowrap;
}
/* `a:hover` global pinta el fondo con --accent; un número de issue no es un
   link de texto, así que el fondo se redefine acá (ver DESIGN_SYSTEM.md). */
.task-number-link:hover,
.task-number-link:focus-visible {
  background: transparent;
  color: var(--info);
}
.task-number-glyph { margin-left: 0.15rem; color: var(--fg-dimmer); }
.task-number-link:hover .task-number-glyph { color: var(--info); }

/* Prosa → Sans. El título envuelve en vez de truncar: esconder su final
   esconde justo lo que distingue una tarea de otra. */
.task-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-body-sm);
  line-height: var(--row-h);
  color: var(--fg);
  overflow-wrap: anywhere;
}
.task-status-chip {
  flex: 0 0 auto;
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  padding: 0 0.4rem;
  border-radius: var(--radius-sm);
  background: var(--panel-hi);
  color: var(--fg-dim);
  white-space: nowrap;
}

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

.task-blocked-badge {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  padding: 0 0.4rem;
  border-radius: var(--radius-sm);
  background: var(--red-bg);
  color: var(--danger);
  white-space: nowrap;
}
.task-blocked-glyph { margin-right: 0.25rem; }

/* Los tags ocupan lo que necesitan y la acción queda pegada a la derecha, en la
   misma fila: pedir review es una acción SOBRE lo que los tags describen (el PR
   y su CI), no un ítem más de la tarjeta. */
.task-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-width: 0;
}
.task-slack-btn { flex: 0 0 auto; }
.task-slack-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.task-blockers { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; min-width: 0; }
.task-blocker-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 0.3rem;
  min-width: 0;
  max-width: min(38ch, 100%);
  padding: 0 0.4rem;
  border: 1px solid var(--warn);
  border-radius: var(--radius-sm);
  background: var(--yellow-bg);
  color: var(--warn);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  white-space: nowrap;
}
.task-blocker-chip.is-plain { cursor: default; }
/* Mismo motivo que .task-number-link: sin esto el chip se pinta de teal. */
.task-blocker-chip:hover:not(.is-plain) {
  background: var(--yellow-bg);
  border-color: var(--fg-mute);
  color: var(--warn);
}
.task-blocker-ref { flex: 0 0 auto; font-weight: 600; }
.task-blocker-title { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.task-blocker-status { flex: 0 0 auto; color: var(--fg-dim); }
</style>
