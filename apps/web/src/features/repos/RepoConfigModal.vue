<script setup lang="ts">
import { ref, watch } from 'vue';
import type { RepoMappingEntry, RepoWorkflow } from '@ia-flow/shared';
import { computed } from 'vue';
import { getOwners, getRepos, type GithubOwner } from '@/features/github/api';
import { getLocalRepos, type LocalRepo } from '@/features/repos/api';
import AutocompleteSelect from '@/ui/AutocompleteSelect.vue';

interface RepoFormData {
  name: string;
  path: string;
  githubOwner: string;
  githubRepo: string;
  workflow: RepoWorkflow | '';
}

const props = defineProps<{
  open: boolean;
  editingName?: string;
  editingEntry?: RepoMappingEntry;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'save', newName: string, oldName: string | undefined, entry: RepoMappingEntry): void;
}>();

const form = ref<RepoFormData>({ name: '', path: '', githubOwner: '', githubRepo: '', workflow: '' });
const nameError = ref('');

const owners = ref<GithubOwner[]>([]);
const ownersLoading = ref(false);
const ownersError = ref('');

const repos = ref<string[]>([]);
const reposLoading = ref(false);
const reposError = ref('');

const localRepos = ref<LocalRepo[]>([]);
const localReposLoading = ref(false);
const localReposError = ref('');

const localPathOptions = computed(() =>
  localRepos.value.map((r) => r.path),
);

async function loadLocalRepos() {
  localReposLoading.value = true;
  localReposError.value = '';
  try {
    const res = await getLocalRepos();
    localRepos.value = res.repos ?? [];
    if (res.error) localReposError.value = res.error;
  } catch (e) {
    localReposError.value = e instanceof Error ? e.message : String(e);
  } finally {
    localReposLoading.value = false;
  }
}

function onPathChange(newPath: string) {
  form.value.path = newPath;
  // If the path matches a known local repo, prefill Nombre when empty
  const match = localRepos.value.find((r) => r.path === newPath);
  if (match && !form.value.name.trim()) {
    form.value.name = match.name;
    nameError.value = '';
  }
}

async function loadOwners() {
  ownersLoading.value = true;
  ownersError.value = '';
  try {
    const res = await getOwners();
    owners.value = res.owners ?? [];
    if (res.error) ownersError.value = res.error;
  } catch (e) {
    ownersError.value = e instanceof Error ? e.message : String(e);
  } finally {
    ownersLoading.value = false;
  }
}

async function loadRepos(owner: string) {
  if (!owner) {
    repos.value = [];
    return;
  }
  reposLoading.value = true;
  reposError.value = '';
  try {
    const res = await getRepos(owner);
    repos.value = res.repos ?? [];
    if (res.error) reposError.value = res.error;
  } catch (e) {
    reposError.value = e instanceof Error ? e.message : String(e);
  } finally {
    reposLoading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    nameError.value = '';
    if (props.editingName != null) {
      const e = props.editingEntry ?? {};
      form.value = {
        name: props.editingName,
        path: e.path ?? '',
        githubOwner: e.githubOwner ?? '',
        githubRepo: e.githubRepo ?? '',
        workflow: e.workflow ?? '',
      };
    } else {
      form.value = { name: '', path: '', githubOwner: '', githubRepo: '', workflow: '' };
    }
    void loadOwners();
    void loadLocalRepos();
    if (form.value.githubOwner) void loadRepos(form.value.githubOwner);
    else repos.value = [];
  },
);

watch(
  () => form.value.githubOwner,
  (owner, prev) => {
    if (!props.open) return;
    if (owner === prev) return;
    // Clear repo selection when owner changes (unless it's the initial hydration match)
    if (prev !== undefined && prev !== '') form.value.githubRepo = '';
    void loadRepos(owner);
  },
);

function onSave() {
  const name = form.value.name.trim();
  if (!name) {
    nameError.value = 'El nombre es obligatorio';
    return;
  }
  const entry: RepoMappingEntry = {};
  if (form.value.path.trim()) entry.path = form.value.path.trim();
  if (form.value.githubOwner.trim()) entry.githubOwner = form.value.githubOwner.trim();
  if (form.value.githubRepo.trim()) entry.githubRepo = form.value.githubRepo.trim();
  if (form.value.workflow) entry.workflow = form.value.workflow;
  emit('save', name, props.editingName, entry);
}

function onBackdropClick(e: MouseEvent) {
  if (e.target === e.currentTarget) emit('close');
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click="onBackdropClick">
      <div class="modal" role="dialog" aria-modal="true">
        <header class="modal-header">
          <h2>{{ editingName != null ? 'Editar repo' : 'Agregar repo' }}</h2>
          <button class="close-btn" type="button" aria-label="Cerrar" @click="$emit('close')">✕</button>
        </header>

        <div class="modal-body">
          <div class="field">
            <label for="repo-name">Nombre *</label>
            <input
              id="repo-name"
              v-model="form.name"
              type="text"
              placeholder="subscriptions"
              :class="{ error: nameError }"
              @input="nameError = ''"
            />
            <span v-if="nameError" class="field-error">{{ nameError }}</span>
            <span v-else class="field-hint">Identificador del repo en tareas</span>
          </div>

          <div class="field">
            <label for="repo-path">Path local</label>
            <AutocompleteSelect
              id="repo-path"
              :model-value="form.path"
              :options="localPathOptions"
              :loading="localReposLoading"
              :error="localReposError"
              placeholder="Buscar repo local (ej. subscriptions)…"
              empty-text="Sin repos que coincidan"
              @update:model-value="onPathChange"
            />
            <span class="field-hint">Autocompleta desde <code>~/development/lahaus</code> y <code>EXTRA_REPOS</code>. Podés escribir un path manual también.</span>
          </div>

          <div class="field-group">
            <div class="field">
              <label for="repo-gh-owner">GitHub owner</label>
              <select
                id="repo-gh-owner"
                v-model="form.githubOwner"
                :disabled="ownersLoading"
              >
                <option value="">— seleccionar —</option>
                <option
                  v-if="form.githubOwner && !owners.some(o => o.login === form.githubOwner)"
                  :value="form.githubOwner"
                >{{ form.githubOwner }} (guardado)</option>
                <option v-for="o in owners" :key="o.login" :value="o.login">
                  {{ o.login }}{{ o.type === 'user' ? ' (tú)' : '' }}
                </option>
              </select>
              <span v-if="ownersLoading" class="field-hint">Cargando owners…</span>
              <span v-else-if="ownersError" class="field-error">{{ ownersError }}</span>
            </div>
            <div class="field">
              <label for="repo-gh-repo">GitHub repo</label>
              <AutocompleteSelect
                id="repo-gh-repo"
                v-model="form.githubRepo"
                :options="repos"
                :loading="reposLoading"
                :error="reposError"
                :disabled="!form.githubOwner"
                :placeholder="form.githubOwner ? 'Buscar repo…' : 'Selecciona un owner primero'"
                empty-text="Sin repos que coincidan"
              />
              <span class="field-hint">Si está vacío se usa el Nombre para tareas.</span>
            </div>
          </div>

          <div class="field">
            <label for="repo-workflow">Workflow</label>
            <select id="repo-workflow" v-model="form.workflow">
              <option value="">— sin configurar —</option>
              <option value="worktree">Worktree — worktree paralelo en directorio hermano</option>
              <option value="branch">Branch — rama nueva sobre el checkout actual</option>
              <option value="main">Main — commit directo en la rama principal</option>
            </select>
          </div>
        </div>

        <footer class="modal-footer">
          <button type="button" class="btn-secondary" @click="$emit('close')">Cancelar</button>
          <button type="button" class="btn-primary" @click="onSave">Guardar</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  width: 100%;
  max-width: 520px;
  display: flex;
  flex-direction: column;
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem 0.75rem;
  border-bottom: 1px solid #e5e7eb;
}
.modal-header h2 {
  margin: 0;
  font-size: 1.1rem;
}
.close-btn {
  background: none;
  border: none;
  font-size: 1rem;
  cursor: pointer;
  color: #6b7280;
  line-height: 1;
  padding: 0.25rem;
}
.close-btn:hover {
  color: #111;
}
.modal-body {
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.field label {
  font-size: 0.85rem;
  font-weight: 500;
  color: #374151;
}
.field input,
.field select {
  padding: 0.4rem 0.6rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.875rem;
  background: #fff;
}
.field input.error {
  border-color: #ef4444;
}
.field input:focus,
.field select:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}
.field-hint {
  font-size: 0.75rem;
  color: #9ca3af;
}
.field-error {
  font-size: 0.75rem;
  color: #ef4444;
}
.field-group {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem 1rem;
  border-top: 1px solid #e5e7eb;
}
.btn-primary {
  padding: 0.45rem 1.1rem;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
}
.btn-primary:hover {
  background: #1d4ed8;
}
.btn-secondary {
  padding: 0.45rem 1.1rem;
  background: #fff;
  color: #374151;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
}
.btn-secondary:hover {
  background: #f9fafb;
}
</style>
