<script setup lang="ts">
import type { RepoMappingEntry } from '@ia-flow/shared';
import { computed, onMounted, ref, watch } from 'vue';
import RepoConfigModal from '@/features/repos/RepoConfigModal.vue';
import RepoInlineForm from '@/features/repos/RepoInlineForm.vue';
import {
  type DbRepoEntry,
  deleteRepoMapping,
  getRepoMappings,
  upsertRepoMapping,
} from '@/features/repos/api';
import { useProjectsStore } from '@/features/projects/store';
import { useToastStore } from '@/stores/toast';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import EditableCard from '@/ui/EditableCard.vue';

// Repos of the active project. Uses the existing modal / inline form.
const projectsStore = useProjectsStore();
const toastStore = useToastStore();

const repos = ref<DbRepoEntry[]>([]);
const modalOpen = ref(false);
const editingRepoName = ref<string | undefined>(undefined);
const editingRepoEntry = ref<RepoMappingEntry | undefined>(undefined);
const expandedRepoName = ref<string | null>(null);

const projectId = computed(() => projectsStore.activeProjectId);

const repoList = computed(() =>
  repos.value.map((r) => {
    const { name, projectId: _pid, ...entry } = r;
    return { name, entry: entry as RepoMappingEntry };
  }),
);

async function load() {
  if (!projectId.value) { repos.value = []; return; }
  try {
    repos.value = await getRepoMappings(projectId.value);
  } catch (e) {
    toastStore.error(`Error cargando repos: ${e instanceof Error ? e.message : String(e)}`);
    repos.value = [];
  }
}

onMounted(load);
watch(projectId, load);

function openAdd() {
  editingRepoName.value = undefined;
  editingRepoEntry.value = undefined;
  expandedRepoName.value = null;
  modalOpen.value = true;
}

function toggleExpand(name: string) {
  expandedRepoName.value = expandedRepoName.value === name ? null : name;
}

async function handleDelete(name: string) {
  if (!projectId.value) return;
  try {
    await deleteRepoMapping(name, projectId.value);
    repos.value = repos.value.filter((r) => r.name !== name);
    toastStore.success(`Repo '${name}' eliminado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function handleModalSave(
  newName: string,
  oldName: string | undefined,
  entry: RepoMappingEntry,
) {
  const pid = projectId.value;
  if (!pid) return;
  try {
    if (oldName != null && oldName !== newName) await deleteRepoMapping(oldName, pid);
    await upsertRepoMapping(newName, entry, pid);
    await load();
    modalOpen.value = false;
    toastStore.success(`Repo '${newName}' guardado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function handleInlineSave(oldName: string, newName: string, entry: RepoMappingEntry) {
  const pid = projectId.value;
  if (!pid) return;
  try {
    if (oldName !== newName) await deleteRepoMapping(oldName, pid);
    await upsertRepoMapping(newName, entry, pid);
    await load();
    expandedRepoName.value = null;
    toastStore.success(`Repo '${newName}' guardado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

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
</script>

<template>
  <section class="prt-section">
    <div class="prt-header">
      <div>
        <h2>Repos del proyecto</h2>
        <p class="prt-desc">
          Repos disponibles para este proyecto. Cada entrada tiene dos roles:
          <br>· <strong>Contexto</strong> — el agente lee el <em>path local</em> antes de actuar.
          <br>· <strong>Selección en tareas</strong> — el <em>nombre</em> es lo que aparece en el campo Repos de cada tarea.
          <br>La <em>descripción</em> se expone a los agentes vía <code v-pre>{{project.repos}}</code>.
        </p>
      </div>
      <button class="prt-btn-add" type="button" @click="openAdd">+ Agregar</button>
    </div>

    <div class="prt-legend">
      <span class="prt-l-item"><span class="prt-badge prt-badge--worktree">worktree</span> — worktree paralelo en directorio hermano</span>
      <span class="prt-l-item"><span class="prt-badge prt-badge--branch">branch</span> — rama nueva sobre el checkout actual</span>
      <span class="prt-l-item"><span class="prt-badge prt-badge--main">main</span> — commit directo en la rama principal</span>
    </div>

    <div v-if="!repoList.length" class="prt-empty">
      No hay repos configurados para este proyecto. Agrega uno para empezar.
    </div>

    <div class="prt-list">
      <template v-for="{ name, entry } in repoList" :key="name">
        <EditableCard
          v-if="expandedRepoName !== name"
          :clickable="true"
          @edit="toggleExpand(name)"
          @delete="askConfirm({
            title: 'Eliminar repo',
            message: `¿Eliminar el repo '${name}' de este proyecto?`,
            confirmLabel: 'Eliminar',
            onConfirm: () => handleDelete(name),
          })"
        >
          <div class="prt-card-main">
            <span class="prt-name">{{ name }}</span>
            <span v-if="entry.workflow" class="workflow-badge" :data-workflow="entry.workflow">
              {{ entry.workflow }}
            </span>
          </div>
          <div v-if="entry.description" class="prt-card-desc" :title="entry.description">{{ entry.description }}</div>
          <div class="prt-card-meta">
            <span v-if="entry.path" class="prt-meta prt-meta--path" :title="entry.path">{{ entry.path }}</span>
            <span v-if="entry.githubOwner || entry.githubRepo" class="prt-meta prt-meta--github">
              {{ [entry.githubOwner, entry.githubRepo].filter(Boolean).join('/') }}
            </span>
          </div>
        </EditableCard>

        <RepoInlineForm
          v-else
          :name="name"
          :entry="entry"
          @save="(newName, newEntry) => handleInlineSave(name, newName, newEntry)"
          @cancel="expandedRepoName = null"
        />
      </template>
    </div>
  </section>

  <RepoConfigModal
    :open="modalOpen"
    :editing-name="editingRepoName"
    :editing-entry="editingRepoEntry"
    @close="modalOpen = false"
    @save="handleModalSave"
  />

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
.prt-section {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1.25rem;
}
.prt-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
}
.prt-header h2 { margin: 0 0 0.25rem; font-size: 1.05rem; }
.prt-desc { margin: 0; color: var(--fg-dim); font-size: 0.85rem; line-height: 1.5; }
.prt-btn-add {
  flex-shrink: 0;
  padding: 0.4rem 0.9rem;
  background: var(--fg);
  color: var(--panel);
  border: none;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.prt-btn-add:hover { background: #000; }

.prt-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1.25rem;
  margin-bottom: 0.85rem;
  font-size: 0.76rem;
  color: var(--fg-dim);
}
.prt-l-item { display: flex; align-items: center; gap: 0.4rem; }
.prt-badge { font-size: 0.68rem; padding: 0.1rem 0.45rem; border-radius: 4px; font-weight: 500; }
.prt-badge--worktree { background: var(--panel-hi); color: var(--accent); }
.prt-badge--branch   { background: var(--green-bg); color: var(--accent); }
.prt-badge--main     { background: var(--yellow-bg); color: var(--warn); }

.prt-empty {
  padding: 1rem;
  color: var(--fg-dim);
  background: var(--panel-alt);
  border-radius: 6px;
  text-align: center;
  font-size: 0.88rem;
}

.prt-list { display: flex; flex-direction: column; gap: 0.5rem; }
.prt-card-main { display: flex; align-items: center; gap: 0.5rem; }
.prt-name { font-weight: 600; font-size: 0.9rem; }
.workflow-badge { font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 4px; font-weight: 500; background: var(--panel-hi); color: var(--fg-mute); }
.workflow-badge[data-workflow='worktree'] { background: var(--panel-hi); color: var(--accent); }
.workflow-badge[data-workflow='branch']   { background: var(--green-bg); color: var(--accent); }
.workflow-badge[data-workflow='main']     { background: var(--yellow-bg); color: var(--warn); }

.prt-card-desc {
  font-size: 0.78rem;
  color: #475569;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 520px;
  margin: 0.1rem 0;
}
.prt-card-meta { display: flex; flex-direction: column; gap: 0.1rem; }
.prt-meta {
  font-size: 0.78rem;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 520px;
}
.prt-meta--github { color: var(--fg-mute); }
</style>
