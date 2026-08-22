<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { ref, watch } from 'vue';
import type { RepoMappingEntry, RepoWorkflow } from '@ia-flow/shared';
import { computed } from 'vue';
import { getLocalRepos, type LocalRepo } from '@/features/repos/api';
import GithubRepoField from '@/features/repos/GithubRepoField.vue';
import RepoDescriptionField from '@/features/repos/RepoDescriptionField.vue';
import AutocompleteSelect from '@/ui/AutocompleteSelect.vue';

interface RepoFormData {
  name: string;
  description: string;
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

const form = ref<RepoFormData>({ name: '', description: '', path: '', githubOwner: '', githubRepo: '', workflow: '' });
const nameError = ref('');

// El autocomplete de owner/repo de GitHub (y sus llamadas a la API) vive en
// GithubRepoField — acá sólo queda el del path local.
const localRepos = ref<LocalRepo[]>([]);
const localReposLoading = ref(false);
const localReposError = ref('');

const localPathOptions = computed(() =>
  localRepos.value.map((r) => r.path),
);

const descriptionContext = computed(() => {
  const payload = JSON.stringify(
    {
      name: form.value.name.trim() || null,
      path: form.value.path.trim() || null,
      githubOwner: form.value.githubOwner.trim() || null,
      githubRepo: form.value.githubRepo.trim() || null,
    },
    null,
    2,
  );
  // Match the shape the seed prompt (repoDescriptionAssistant) expects:
  // a bare JSON with { name, path, githubOwner, githubRepo }. No behavioural
  // guidance here — the system prompt already handles with/without tools.
  return `Repo:\n${payload}`;
});

const descriptionContextPreview = computed(() => {
  const parts: string[] = [];
  const n = form.value.name.trim();
  const p = form.value.path.trim();
  const o = form.value.githubOwner.trim();
  const r = form.value.githubRepo.trim();
  if (n) parts.push(n);
  if (p) parts.push(p);
  if (o || r) parts.push([o, r].filter(Boolean).join('/'));
  return parts.join(' · ');
});

const hasAiContext = computed(
  () => !!form.value.path.trim() || !!form.value.githubRepo.trim(),
);

const aiRepoContexts = computed(() => {
  const name = form.value.name.trim() || 'repo';
  const path = form.value.path.trim();
  return path ? [{ name, path }] : [];
});

const AI_DEFAULT_TOOLS = ['read_file', 'list_dir', 'grep_files'];

async function loadLocalRepos() {
  localReposLoading.value = true;
  localReposError.value = '';
  try {
    const res = await getLocalRepos();
    localRepos.value = res.repos ?? [];
    if (res.error) localReposError.value = res.error;
  } catch (e) {
    localReposError.value = extractErrorMessage(e);
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

function onGithubChange(next: { owner: string; repo: string }) {
  form.value.githubOwner = next.owner;
  form.value.githubRepo = next.repo;
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
        description: e.description ?? '',
        path: e.path ?? '',
        githubOwner: e.githubOwner ?? '',
        githubRepo: e.githubRepo ?? '',
        workflow: e.workflow ?? '',
      };
    } else {
      form.value = { name: '', description: '', path: '', githubOwner: '', githubRepo: '', workflow: '' };
    }
    void loadLocalRepos();
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
  if (form.value.description.trim()) entry.description = form.value.description.trim();
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

          <div class="field">
            <label for="repo-gh">Repo de GitHub</label>
            <GithubRepoField
              id="repo-gh"
              :owner="form.githubOwner"
              :repo="form.githubRepo"
              @update:model-value="onGithubChange"
            />
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

          <div class="field">
            <RepoDescriptionField
              v-model="form.description"
              :context-fallback="descriptionContext"
              :context-preview="descriptionContextPreview"
              :ai-disabled="!hasAiContext"
              :default-tools="AI_DEFAULT_TOOLS"
              :repo-contexts="aiRepoContexts"
              system-prompt-id="repoDescriptionAssistant"
              placeholder="Breve descripción (qué es, para qué se usa)."
            />
            <span class="field-hint">Se muestra a los agentes vía <code v-pre>{{project.repos}}</code>.</span>
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
  background: var(--panel);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  width: 100%;
  max-width: 520px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem 0.75rem;
  border-bottom: 1px solid var(--border);
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
  color: var(--fg-dim);
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
  overflow-y: auto;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.field label {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--fg-mute);
}
.field input,
.field select {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-size: 0.875rem;
  background: var(--panel);
}
.field input.error {
  border-color: var(--danger);
}
.field input:focus,
.field select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}
.field-hint {
  font-size: 0.75rem;
  color: var(--fg-dim);
}
.field-error {
  font-size: 0.75rem;
  color: var(--danger);
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
  border-top: 1px solid var(--border);
}
.btn-primary {
  padding: 0.45rem 1.1rem;
  background: var(--accent);
  color: var(--panel);
  border: none;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
}
.btn-primary:hover {
  background: var(--accent);
}
.btn-secondary {
  padding: 0.45rem 1.1rem;
  background: var(--panel);
  color: var(--fg-mute);
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
}
.btn-secondary:hover {
  background: var(--panel-alt);
}
</style>
