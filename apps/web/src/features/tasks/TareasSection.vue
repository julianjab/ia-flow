<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import ItemReposModal from '@/features/repos/ItemReposModal.vue';
import { getRepoMappings } from '@/features/repos/api';
import { useProjectsStore } from '@/features/projects/store';
import {
  fetchProjectItems,
  setProjectItemField,
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
}

const projectsStore = useProjectsStore();
const toastStore = useToastStore();

const projectItems = ref<TaskRow[]>([]);
const itemsLoading = ref(false);
const itemsError = ref('');
const reposModalOpen = ref(false);
const reposModalItem = ref<TaskRow | null>(null);
const reposModalSaving = ref(false);

const availableRepoNames = ref<string[]>([]);

const activeProjectId = computed(() => projectsStore.activeProjectId);

function toRow(item: SourceItem): TaskRow {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    issueNumber: item.meta?.issueNumber as number | undefined,
    repos: item.repos ?? '',
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
  } catch (e) {
    itemsError.value = e instanceof Error ? e.message : String(e);
  } finally {
    itemsLoading.value = false;
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
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
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

    <ul v-else class="task-list">
      <li v-for="item in projectItems" :key="item.id" class="task-card">
        <div class="task-card-main">
          <span v-if="item.issueNumber" class="task-number">#{{ item.issueNumber }}</span>
          <span class="task-title">{{ item.title }}</span>
          <span v-if="item.status" class="task-status-chip">{{ item.status }}</span>
        </div>
        <div class="task-repos-row">
          <div class="task-repo-chips">
            <span v-for="r in currentReposOf(item)" :key="r" class="task-repo-chip">{{ r }}</span>
            <span v-if="!currentReposOf(item).length" class="task-repos-empty">Sin repos</span>
          </div>
          <button type="button" class="btn-edit" @click="openReposModal(item)">Editar repos</button>
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
.settings-section { border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem; }
.settings-section h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.section-desc { margin: 0 0 0.9rem; font-size: 0.82rem; color: #6b7280; line-height: 1.5; }
.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.75rem; }
.section-header h2 { margin: 0 0 0.2rem; font-size: 1.05rem; }

.btn-add-repo {
  flex-shrink: 0;
  padding: 0.35rem 0.8rem;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.btn-add-repo:hover { background: #1d4ed8; }
.btn-add-repo:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-edit {
  padding: 0.3rem 0.65rem;
  border: 1px solid #d1d5db;
  border-radius: 5px;
  background: #fff;
  font-size: 0.8rem;
  cursor: pointer;
  color: #374151;
}
.btn-edit:hover { background: #f3f4f6; }
.repos-empty { font-size: 0.875rem; color: #9ca3af; padding: 0.5rem 0; }

.task-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.45rem; }
.task-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 0.7rem 0.9rem;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.task-card-main { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
.task-number { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.73rem; color: #6b7280; flex-shrink: 0; }
.task-title { font-size: 0.85rem; font-weight: 500; color: #111827; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.task-status-chip { flex-shrink: 0; font-size: 0.68rem; padding: 0.12rem 0.45rem; border-radius: 4px; background: #f3f4f6; color: #374151; font-weight: 500; }
.task-repos-row { display: flex; align-items: center; gap: 0.5rem; }
.task-repo-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; flex: 1; min-width: 0; }
.task-repo-chip { font-size: 0.72rem; padding: 0.1rem 0.45rem; background: #eef2ff; color: #4f46e5; border-radius: 4px; font-family: 'SF Mono', 'Fira Code', monospace; }
.task-repos-empty { font-size: 0.73rem; color: #9ca3af; font-style: italic; }
.items-error { padding: 0.6rem 0.85rem; background: #fef2f2; border: 1px solid #fca5a5; border-radius: 6px; font-size: 0.82rem; color: #dc2626; }
</style>
