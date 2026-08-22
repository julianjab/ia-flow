<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { computed, onMounted, ref, watch } from 'vue';
import ItemReposModal from '@/features/repos/ItemReposModal.vue';
import { getRepoMappings } from '@/features/repos/api';
import { useProjectsStore } from '@/features/projects/store';
import {
  fetchItemBlockers,
  fetchProjectItems,
  setProjectItemField,
  type Blocker,
  type ItemPullRequest,
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
  pullRequests: ItemPullRequest[]
  /** El provider sabe hablar de ramas/PRs. False (p. ej. local-fs) ⇒ no
   * dibujamos la fila de dev links en vez de mentir con "sin rama". */
  hasDevLinks: boolean
}

const PR_STATE_LABEL: Record<ItemPullRequest['state'], string> = {
  open: 'abierto',
  merged: 'mergeado',
  closed: 'cerrado',
};

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
    ? (meta.pullRequests as ItemPullRequest[])
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
  }
}

function prLabel(pr: ItemPullRequest): string {
  return `PR #${pr.number} · ${pr.isDraft ? 'draft' : PR_STATE_LABEL[pr.state]}`;
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
          >#{{ item.issueNumber }} ↗</a>
          <span v-else-if="item.issueNumber" class="task-number">#{{ item.issueNumber }}</span>
          <span class="task-title">{{ item.title }}</span>
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
        <div v-if="item.hasDevLinks" class="task-dev-row">
          <a
            v-if="item.branch && item.branchUrl"
            class="task-dev-chip is-branch"
            :href="item.branchUrl"
            target="_blank"
            rel="noopener"
            :title="`Rama remota: ${item.branch}`"
            @click.stop
          >⎇ {{ item.branch }}</a>
          <span v-else-if="item.branch" class="task-dev-chip is-branch" :title="item.branch">⎇ {{ item.branch }}</span>
          <span v-else class="task-dev-empty">Sin rama remota</span>

          <a
            v-for="pr in item.pullRequests"
            :key="pr.number"
            class="task-dev-chip"
            :class="`is-pr-${pr.isDraft ? 'draft' : pr.state}`"
            :href="pr.url"
            target="_blank"
            rel="noopener"
            :title="pr.title ?? prLabel(pr)"
            @click.stop
          >{{ prLabel(pr) }}</a>
          <span v-if="!item.pullRequests.length" class="task-dev-empty">Sin PR</span>
        </div>
        <div class="task-repos-row">
          <div class="task-repo-chips">
            <span v-for="r in currentReposOf(item)" :key="r" class="task-repo-chip">{{ r }}</span>
            <span v-if="!currentReposOf(item).length" class="task-repos-empty">Sin repos</span>
          </div>
          <button type="button" class="btn-edit" @click.stop="openReposModal(item)">Editar repos</button>
        </div>
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
    @close="reposModalOpen = false"
    @save="handleReposSave"
  />
</template>

<style scoped>
.settings-section { border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
.settings-section h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.section-desc { margin: 0 0 0.9rem; font-size: 0.82rem; color: var(--fg-dim); line-height: 1.5; }
.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.75rem; }
.section-header h2 { margin: 0 0 0.2rem; font-size: 1.05rem; }

.btn-add-repo {
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
.btn-add-repo:hover { background: var(--accent); }
.btn-add-repo:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-edit {
  padding: 0.3rem 0.65rem;
  border: 1px solid var(--border-hi);
  border-radius: 5px;
  background: var(--panel);
  font-size: 0.8rem;
  cursor: pointer;
  color: var(--fg-mute);
}
.btn-edit:hover { background: var(--panel-hi); }
.repos-empty { font-size: 0.875rem; color: var(--fg-dim); padding: 0.5rem 0; }

.task-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.45rem; }
.task-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.7rem 0.9rem;
  background: var(--panel);
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.task-card-main { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
.task-number { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.73rem; color: var(--fg-dim); flex-shrink: 0; }
.task-title { font-size: 0.85rem; font-weight: 500; color: var(--fg); flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.task-status-chip { flex-shrink: 0; font-size: 0.68rem; padding: 0.12rem 0.45rem; border-radius: 4px; background: var(--panel-hi); color: var(--fg-mute); font-weight: 500; }
.task-number-link { text-decoration: none; }
.task-number-link:hover { color: var(--info); text-decoration: underline; }

.task-dev-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; }
.task-dev-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  padding: 0.1rem 0.45rem;
  border: 1px solid var(--border-hi);
  background: var(--panel-hi);
  color: var(--fg-mute);
  text-decoration: none;
  max-width: 34ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-dev-chip:hover { border-color: var(--fg-dim); color: var(--fg); }
.task-dev-chip.is-branch { color: var(--info); border-color: var(--info); }
.task-dev-chip.is-pr-open { color: var(--accent); border-color: var(--accent); }
.task-dev-chip.is-pr-merged { color: var(--ai); border-color: var(--ai); }
.task-dev-chip.is-pr-closed { color: var(--danger); border-color: var(--danger); }
.task-dev-chip.is-pr-draft { color: var(--fg-dim); border-color: var(--border-hi); }
.task-dev-empty { font-size: 0.72rem; color: var(--fg-dimmer); font-style: italic; }

.task-repos-row { display: flex; align-items: center; gap: 0.5rem; }
.task-repo-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; flex: 1; min-width: 0; }
.task-repo-chip { font-size: 0.72rem; padding: 0.1rem 0.45rem; background: var(--panel-hi); color: var(--info); border-radius: 4px; font-family: 'SF Mono', 'Fira Code', monospace; }
.task-repos-empty { font-size: 0.73rem; color: var(--fg-dim); font-style: italic; }
.items-error { padding: 0.6rem 0.85rem; background: var(--red-bg); border: 1px solid var(--danger); border-radius: 6px; font-size: 0.82rem; color: var(--danger); }

.task-blocked-badge {
  flex-shrink: 0;
  font-size: 0.7rem;
  padding: 0.12rem 0.45rem;
  border-radius: 4px;
  background: var(--red-bg);
  color: var(--danger);
  font-weight: 600;
}

.task-blockers { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; padding: 0.15rem 0; }
.task-blockers-label { font-size: 0.72rem; color: var(--fg-dim); font-weight: 500; }
.task-blocker-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.72rem;
  padding: 0.12rem 0.45rem;
  border: 1px solid var(--danger);
  background: var(--yellow-bg);
  color: var(--warn);
  border-radius: 4px;
  text-decoration: none;
  max-width: 100%;
}
.task-blocker-chip.is-plain { cursor: default; }
.task-blocker-chip:hover:not(.is-plain) { background: var(--yellow-bg); border-color: var(--warn); }
.task-blocker-ref { font-family: 'SF Mono', 'Fira Code', monospace; font-weight: 600; }
.task-blocker-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 20ch; }
.task-blocker-status { color: var(--fg-dim); }
</style>
