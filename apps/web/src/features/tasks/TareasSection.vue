<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { computed, onMounted, ref, watch } from 'vue';
import ItemReposModal from '@/features/repos/ItemReposModal.vue';
import { getRepoMappings } from '@/features/repos/api';
import { useProjectsStore } from '@/features/projects/store';
import type { PullRequestRef } from '@ia-flow/shared';
import TaskTags from '@/components/TaskTags.vue';
import {
  fetchItemBlockers,
  fetchProjectItems,
  setProjectItemField,
  type Blocker,
  type SourceItem,
} from '@/features/projects/sourceApi';
import { useToastStore } from '@/stores/toast';

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

const availableRepoNames = ref<string[]>([]);

const activeProjectId = computed(() => projectsStore.activeProjectId);

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
  }
}

async function loadRepoNames() {
  try {
    const entries = await getRepoMappings();
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

onMounted(() => {
  void loadRepoNames();
  void loadProjectItems();
});

// Reload whenever the user switches projects — same pattern as StatusesSection.
watch(activeProjectId, () => {
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
      <button type="button" class="btn" :disabled="itemsLoading" @click="loadProjectItems(true)">
        <span class="btn-glyph">{{ itemsLoading ? '◐' : '↺' }}</span>
        {{ itemsLoading ? 'Cargando…' : 'Actualizar' }}
      </button>
    </div>

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

    <ul v-else class="task-list" data-kbd-list="tasks">
      <li
        v-for="item in projectItems"
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
        <TaskTags
          :repos="currentReposOf(item)"
          :branch="item.branch"
          :branch-url="item.branchUrl"
          :pull-requests="item.pullRequests"
          :dev-links="item.hasDevLinks"
          :pull-requests-known="item.pullRequestsKnown"
          show-empty-repos
        />
      </li>
    </ul>
  </section>

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
