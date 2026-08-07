<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { RepoMapping, RepoMappingEntry } from '@ia-flow/shared';
import EditableCard from '@/ui/EditableCard.vue';
import ConfirmDialog from '@/ui/ConfirmDialog.vue';
import RepoConfigModal from '@/features/repos/RepoConfigModal.vue';
import RepoInlineForm from '@/features/repos/RepoInlineForm.vue';
import { useToastStore } from '@/stores/toast';
import {
  deleteRepoMapping,
  getRepoMappings,
  getScanRoots,
  setScanRoots,
  upsertRepoMapping,
} from '@/features/repos/api';

const toastStore = useToastStore();

// ─── Repo mappings ────────────────────────────────────────────────────────
const repoMappings = ref<RepoMapping>({});
const modalOpen = ref(false);
const editingRepoName = ref<string | undefined>(undefined);
const editingRepoEntry = ref<RepoMappingEntry | undefined>(undefined);
const expandedRepoName = ref<string | null>(null);

const repoList = computed(() =>
  Object.entries(repoMappings.value).map(([name, val]) => ({
    name,
    entry: (typeof val === 'string' ? { githubRepo: val } : val) as RepoMappingEntry,
  })),
);

async function loadRepoMappings() {
  try {
    const entries = await getRepoMappings();
    repoMappings.value = Object.fromEntries(entries.map(({ name, ...rest }) => [name, rest as RepoMappingEntry]));
  } catch {
    /* non-fatal */
  }
}

function openAdd() {
  editingRepoName.value = undefined;
  editingRepoEntry.value = undefined;
  expandedRepoName.value = null;
  modalOpen.value = true;
}

function toggleExpand(name: string) {
  expandedRepoName.value = expandedRepoName.value === name ? null : name;
}

async function deleteRepo(name: string) {
  try {
    await deleteRepoMapping(name);
    const updated = { ...repoMappings.value };
    delete updated[name];
    repoMappings.value = updated;
    toastStore.success(`Repo '${name}' eliminado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function handleModalSave(newName: string, oldName: string | undefined, entry: RepoMappingEntry) {
  try {
    if (oldName != null && oldName !== newName) await deleteRepoMapping(oldName);
    await upsertRepoMapping(newName, entry);
    const updated = { ...repoMappings.value };
    if (oldName != null && oldName !== newName) delete updated[oldName];
    updated[newName] = entry;
    repoMappings.value = updated;
    modalOpen.value = false;
    toastStore.success(`Repo '${newName}' guardado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function handleInlineSave(oldName: string, newName: string, entry: RepoMappingEntry) {
  try {
    if (oldName !== newName) await deleteRepoMapping(oldName);
    await upsertRepoMapping(newName, entry);
    const updated = { ...repoMappings.value };
    if (oldName !== newName) delete updated[oldName];
    updated[newName] = entry;
    repoMappings.value = updated;
    expandedRepoName.value = null;
    toastStore.success(`Repo '${newName}' guardado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── Scan roots ───────────────────────────────────────────────────────────
const scanRoots = ref<string[]>([]);
const newScanRoot = ref('');
const scanRootsSaving = ref(false);

async function loadScanRoots() {
  try { scanRoots.value = await getScanRoots(); } catch { /* non-fatal */ }
}

async function addScanRoot() {
  const root = newScanRoot.value.trim();
  if (!root || scanRoots.value.includes(root)) return;
  const updated = [...scanRoots.value, root];
  scanRootsSaving.value = true;
  try {
    await setScanRoots(updated);
    scanRoots.value = updated;
    newScanRoot.value = '';
    toastStore.success('Directorio de escaneo agregado');
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    scanRootsSaving.value = false;
  }
}

async function removeScanRoot(root: string) {
  const updated = scanRoots.value.filter((r) => r !== root);
  scanRootsSaving.value = true;
  try {
    await setScanRoots(updated);
    scanRoots.value = updated;
    toastStore.success('Directorio eliminado');
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    scanRootsSaving.value = false;
  }
}

onMounted(() => {
  void loadRepoMappings();
  void loadScanRoots();
});

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
  <!-- Scan roots -->
  <section class="settings-section">
    <div class="section-header">
      <div>
        <h2>Directorios de escaneo</h2>
        <p class="section-desc" style="margin: 0.25rem 0 0;">
          Dónde buscar repos al agregar uno nuevo. ia-flow escanea cada directorio
          que agregues aquí y muestra sus subcarpetas como opciones en el campo
          <strong>Path local</strong> del formulario de repo.
          <br>Ejemplo: agregar <code>~/development/personal</code> expone todos los proyectos
          dentro de esa carpeta. <code>~/development/lahaus</code> siempre está incluido.
        </p>
      </div>
    </div>

    <div class="scan-roots-list">
      <div v-if="!scanRoots.length" class="repos-empty">
        Sin directorios adicionales configurados.
      </div>
      <div v-for="root in scanRoots" :key="root" class="scan-root-item">
        <span class="scan-root-path">{{ root }}</span>
        <button type="button" class="scan-root-remove" :disabled="scanRootsSaving" @click="removeScanRoot(root)">✕</button>
      </div>
    </div>

    <div class="scan-root-add">
      <input
        v-model="newScanRoot"
        class="input scan-root-input"
        placeholder="~/development/personal"
        @keydown.enter.prevent="addScanRoot"
      />
      <button type="button" class="btn-add-repo" :disabled="scanRootsSaving || !newScanRoot.trim()" @click="addScanRoot">
        + Agregar
      </button>
    </div>
  </section>

  <!-- Repos unificados -->
  <section class="settings-section">
    <div class="section-header">
      <div>
        <h2>Repos</h2>
        <p class="section-desc" style="margin: 0.25rem 0 0;">
          Los repos que el agente puede usar. Cada entrada tiene dos roles:
          <br>· <strong>Contexto</strong> — el agente lee el <em>path local</em> para entender el código antes de actuar.
          <br>· <strong>Selección en tareas</strong> — el <em>nombre</em> es lo que aparece en el campo Repos de cada tarea.
          <br>Los campos de GitHub (<em>owner · repo · workflow</em>) son opcionales: solo se necesitan cuando el agente tiene que crear ramas, abrir PRs o hacer commits. Para carpetas sin git, déjalos vacíos.
        </p>
      </div>
      <button type="button" class="btn-add-repo" @click="openAdd">+ Agregar</button>
    </div>

    <div class="workflow-legend">
      <span class="wl-item"><span class="wl-badge wl-worktree">worktree</span> — crea un git worktree paralelo en directorio hermano</span>
      <span class="wl-item"><span class="wl-badge wl-branch">branch</span> — abre una rama nueva sobre el checkout actual</span>
      <span class="wl-item"><span class="wl-badge wl-main">main</span> — hace commit directo en la rama principal</span>
    </div>

    <div v-if="repoList.length === 0" class="repos-empty">
      No hay repos configurados. Agrega uno para empezar.
    </div>

    <div class="repo-list">
      <template v-for="{ name, entry } in repoList" :key="name">
        <EditableCard
          v-if="expandedRepoName !== name"
          :clickable="true"
          @edit="toggleExpand(name)"
          @delete="askConfirm({
            title: 'Eliminar repo',
            message: `¿Eliminar el repo '${name}'?`,
            confirmLabel: 'Eliminar',
            onConfirm: () => deleteRepo(name),
          })"
        >
          <div class="repo-card-main">
            <span class="repo-name">{{ name }}</span>
            <span v-if="entry.workflow" class="workflow-badge" :data-workflow="entry.workflow">
              {{ entry.workflow }}
            </span>
          </div>
          <div class="repo-card-meta">
            <span v-if="entry.path" class="meta-path" :title="entry.path">{{ entry.path }}</span>
            <span v-if="entry.githubOwner || entry.githubRepo" class="meta-github">
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
.settings-section { border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem; }
.settings-section h2 { margin: 0 0 0.35rem; font-size: 1.05rem; }
.section-desc { margin: 0 0 0.9rem; font-size: 0.82rem; color: #6b7280; line-height: 1.5; }
.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.75rem; }
.section-header h2 { margin: 0 0 0.2rem; font-size: 1.05rem; }

.input {
  padding: 0.4rem 0.6rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.84rem;
  color: #1e293b;
  background: #fff;
  width: 100%;
  box-sizing: border-box;
  outline: none;
}
.input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }

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

.repos-empty { font-size: 0.875rem; color: #9ca3af; padding: 0.5rem 0; }

.workflow-legend { display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; margin-bottom: 0.85rem; font-size: 0.76rem; color: #6b7280; }
.wl-item { display: flex; align-items: center; gap: 0.4rem; }
.wl-badge { font-size: 0.68rem; padding: 0.1rem 0.45rem; border-radius: 4px; font-weight: 500; }
.wl-worktree { background: #dbeafe; color: #1d4ed8; }
.wl-branch   { background: #d1fae5; color: #065f46; }
.wl-main     { background: #fef3c7; color: #92400e; }

.repo-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.repo-card-main { display: flex; align-items: center; gap: 0.5rem; }
.repo-name { font-weight: 600; font-size: 0.9rem; }
.workflow-badge { font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 4px; font-weight: 500; background: #f3f4f6; color: #374151; }
.workflow-badge[data-workflow='worktree'] { background: #dbeafe; color: #1d4ed8; }
.workflow-badge[data-workflow='branch']   { background: #d1fae5; color: #065f46; }
.workflow-badge[data-workflow='main']     { background: #fef3c7; color: #92400e; }
.repo-card-meta { display: flex; flex-direction: column; gap: 0.1rem; }
.meta-path, .meta-github {
  font-size: 0.78rem;
  color: #6b7280;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 520px;
}
.meta-github { color: #374151; }

.scan-roots-list { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.75rem; }
.scan-root-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  background: #f8fafc;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  font-size: 0.84rem;
}
.scan-root-path { flex: 1; font-family: 'SF Mono', 'Fira Code', monospace; color: #1e293b; font-size: 0.82rem; }
.scan-root-remove {
  padding: 0.15rem 0.45rem;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  background: #fff;
  color: #6b7280;
  font-size: 0.75rem;
  cursor: pointer;
  line-height: 1;
}
.scan-root-remove:hover { background: #fee2e2; border-color: #fca5a5; color: #dc2626; }
.scan-root-remove:disabled { opacity: 0.5; cursor: not-allowed; }
.scan-root-add { display: flex; gap: 0.5rem; align-items: center; }
.scan-root-input { flex: 1; }
</style>
