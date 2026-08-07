<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import ItemReposModal from '../ItemReposModal.vue';
import { getProjectItems, updateItemRepos, type ProjectItem } from '../../api/github';
import { getRepoMappings } from '../../api/repos';
import { useToastStore } from '../../stores/toast';

const toastStore = useToastStore();

const projectItems = ref<ProjectItem[]>([]);
const itemsLoading = ref(false);
const itemsError = ref('');
const reposModalOpen = ref(false);
const reposModalItem = ref<ProjectItem | null>(null);
const reposModalSaving = ref(false);

const availableRepoNames = ref<string[]>([]);

async function loadRepoNames() {
  try {
    const entries = await getRepoMappings();
    availableRepoNames.value = [...new Set(entries.map((e) => e.name))].sort();
  } catch {
    /* non-fatal */
  }
}

async function loadProjectItems(refresh = false) {
  itemsLoading.value = true;
  itemsError.value = '';
  try {
    const res = await getProjectItems(refresh);
    if (res.error) { itemsError.value = res.error; return; }
    projectItems.value = res.items ?? [];
  } catch (e) {
    itemsError.value = e instanceof Error ? e.message : String(e);
  } finally {
    itemsLoading.value = false;
  }
}

function currentReposOf(item: ProjectItem): string[] {
  return item.repos.split(',').map((r) => r.trim()).filter(Boolean);
}

function openReposModal(item: ProjectItem) {
  reposModalItem.value = item;
  reposModalOpen.value = true;
}

async function handleReposSave(repos: string[]) {
  if (!reposModalItem.value) return;
  reposModalSaving.value = true;
  try {
    await updateItemRepos(reposModalItem.value.id, repos);
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
  if (!projectItems.value.length) void loadProjectItems();
});
</script>

<template>
  <section class="settings-section">
    <div class="section-header">
      <div>
        <h2>Tareas del proyecto</h2>
        <p class="section-desc" style="margin: 0.25rem 0 0;">
          Issues del GitHub Project. Edita el campo <strong>Repos</strong> con un multiselect
          de los repos configurados.
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
      No hay tareas. Asegúrate de que <code>GITHUB_PROJECT_URL</code> esté configurada.
    </div>

    <ul v-else class="task-list">
      <li v-for="item in projectItems" :key="item.id" class="task-card">
        <div class="task-card-main">
          <span class="task-number">#{{ item.issueNumber }}</span>
          <span class="task-title">{{ item.issueTitle }}</span>
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
    :issue-title="reposModalItem?.issueTitle ?? ''"
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
