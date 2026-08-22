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
      <div>
        <h2>Tareas del proyecto</h2>
        <p class="section-desc" style="margin: 0.25rem 0 0;">
          Items del provider de este proyecto. Edita el campo <strong>Repos</strong> con un
          multiselect de los repos configurados.
        </p>
      </div>
      <button type="button" class="btn-add-repo" :disabled="itemsLoading" @click="loadProjectItems(true)">
        {{ itemsLoading ? 'Cargando…' : '↺ Actualizar' }}
      </button>
    </div>

    <div v-if="itemsError" class="items-error">{{ itemsError }}</div>

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
          >⛔ {{ blockersByTask[item.id]!.length }}</span>
        </div>
        <div v-if="(blockersByTask[item.id]?.length ?? 0) > 0" class="task-blockers">
          <span class="task-blockers-label">Bloqueada por:</span>
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
.settings-section { border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem; }
.settings-section h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.section-desc { margin: 0 0 0.9rem; font-size: var(--fs-chrome); color: var(--fg-dim); line-height: 1.5; }
.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.75rem; }
.section-header h2 { margin: 0 0 0.2rem; font-size: 1.05rem; }

.btn-add-repo {
  flex-shrink: 0;
  padding: 0.35rem 0.8rem;
  background: var(--accent);
  color: var(--panel);
  border: none;
  border-radius: var(--radius-sm);
  font-size: var(--fs-body-sm);
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.btn-add-repo:disabled { opacity: 0.6; cursor: not-allowed; }
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
.task-card:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }

.task-card-main {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  min-width: 0;
  min-height: var(--row-h);
}
/* El número nunca encoge ni se parte: es el ancla de lectura de la fila.
   Lo que cede espacio es el título, que trunca con ellipsis y lleva el
   texto completo en su `title`. */
.task-number {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  color: var(--fg-dim);
  white-space: nowrap;
}
.task-number-link { text-decoration: none; }
.task-number-link:hover,
.task-number-link:focus-visible { color: var(--info); }
.task-number-glyph { margin-left: 0.15rem; color: var(--fg-dimmer); }
.task-number-link:hover .task-number-glyph { color: var(--info); }

/* El título envuelve en vez de truncar. El nowrap+ellipsis venía del layout
   original (63d7074) y no lo pide ningún patrón del design system: en una
   card que ya es multilínea sólo servía para esconder el final del título.
   `anywhere` cubre los títulos con un token larguísimo y sin espacios. */
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

.items-error { padding: 0.6rem 0.85rem; background: var(--red-bg); border: 1px solid var(--danger); border-radius: var(--radius-sm); font-size: var(--fs-chrome); color: var(--danger); }

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

.task-blockers { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; min-width: 0; }
.task-blockers-label { font-size: var(--fs-micro); color: var(--fg-dim); }
.task-blocker-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 0.3rem;
  min-width: 0;
  max-width: min(38ch, 100%);
  padding: 0 0.4rem;
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  background: var(--red-bg);
  color: var(--warn);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  text-decoration: none;
  white-space: nowrap;
}
.task-blocker-chip.is-plain { cursor: default; }
.task-blocker-chip:hover:not(.is-plain) { border-color: var(--warn); }
.task-blocker-ref { flex: 0 0 auto; font-weight: 600; }
.task-blocker-title { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.task-blocker-status { flex: 0 0 auto; color: var(--fg-dim); }
</style>
