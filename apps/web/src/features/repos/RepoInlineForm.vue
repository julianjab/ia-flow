<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { RepoMappingEntry, RepoWorkflow } from '@ia-flow/shared';
import { getOwners, getRepos, type GithubOwner } from '@/features/github/api';
import { getLocalRepos, type LocalRepo } from '@/features/repos/api';
import RepoDescriptionField from '@/features/repos/RepoDescriptionField.vue';
import AutocompleteSelect from '@/ui/AutocompleteSelect.vue';

const props = defineProps<{
  name: string
  entry: RepoMappingEntry
}>();

const emit = defineEmits<{
  save: [name: string, entry: RepoMappingEntry]
  cancel: []
}>();

interface Form {
  name: string
  description: string
  path: string
  githubOwner: string
  githubRepo: string
  workflow: RepoWorkflow | ''
}

const form = ref<Form>({
  name: props.name,
  description: props.entry.description ?? '',
  path: props.entry.path ?? '',
  githubOwner: props.entry.githubOwner ?? '',
  githubRepo: props.entry.githubRepo ?? '',
  workflow: props.entry.workflow ?? '',
})
const nameError = ref('')

const descriptionContext = computed(() =>
  JSON.stringify(
    {
      name: form.value.name.trim() || null,
      path: form.value.path.trim() || null,
      githubOwner: form.value.githubOwner.trim() || null,
      githubRepo: form.value.githubRepo.trim() || null,
    },
    null,
    2,
  ),
)

const descriptionContextPreview = computed(() => {
  const parts: string[] = []
  const n = form.value.name.trim()
  const p = form.value.path.trim()
  const o = form.value.githubOwner.trim()
  const r = form.value.githubRepo.trim()
  if (n) parts.push(n)
  if (p) parts.push(p)
  if (o || r) parts.push([o, r].filter(Boolean).join('/'))
  return parts.join(' · ')
})

const hasAiContext = computed(
  () => !!form.value.path.trim() || !!form.value.githubRepo.trim(),
)

// Reset form when props change (different card expanded)
watch(() => props.name, () => {
  form.value = {
    name: props.name,
    description: props.entry.description ?? '',
    path: props.entry.path ?? '',
    githubOwner: props.entry.githubOwner ?? '',
    githubRepo: props.entry.githubRepo ?? '',
    workflow: props.entry.workflow ?? '',
  }
  nameError.value = ''
}, { immediate: true })

// ── Owner / repo autocomplete ──────────────────────────────────────────────

const owners = ref<GithubOwner[]>([])
const ownersLoading = ref(false)
const ownersError = ref('')

const repos = ref<string[]>([])
const reposLoading = ref(false)
const reposError = ref('')

const localRepos = ref<LocalRepo[]>([])
const localReposLoading = ref(false)
const localReposError = ref('')

const localPathOptions = computed(() => localRepos.value.map(r => r.path))

async function loadOwners() {
  ownersLoading.value = true
  ownersError.value = ''
  try {
    const res = await getOwners()
    owners.value = res.owners ?? []
    if (res.error) ownersError.value = res.error
  } catch (e) {
    ownersError.value = e instanceof Error ? e.message : String(e)
  } finally {
    ownersLoading.value = false
  }
}

async function loadRepos(owner: string) {
  if (!owner) { repos.value = []; return }
  reposLoading.value = true
  reposError.value = ''
  try {
    const res = await getRepos(owner)
    repos.value = res.repos ?? []
    if (res.error) reposError.value = res.error
  } catch (e) {
    reposError.value = e instanceof Error ? e.message : String(e)
  } finally {
    reposLoading.value = false
  }
}

async function loadLocalRepos() {
  localReposLoading.value = true
  localReposError.value = ''
  try {
    const res = await getLocalRepos()
    localRepos.value = res.repos ?? []
    if (res.error) localReposError.value = res.error
  } catch (e) {
    localReposError.value = e instanceof Error ? e.message : String(e)
  } finally {
    localReposLoading.value = false
  }
}

// Load data on mount
void loadOwners()
void loadLocalRepos()
if (props.entry.githubOwner) void loadRepos(props.entry.githubOwner)

watch(() => form.value.githubOwner, (owner, prev) => {
  if (owner === prev) return
  if (prev !== undefined && prev !== '') form.value.githubRepo = ''
  void loadRepos(owner)
})

function onPathChange(newPath: string) {
  form.value.path = newPath
  const match = localRepos.value.find(r => r.path === newPath)
  if (match && !form.value.name.trim()) {
    form.value.name = match.name
    nameError.value = ''
  }
}

function onSave() {
  const name = form.value.name.trim()
  if (!name) { nameError.value = 'El nombre es obligatorio'; return }
  const entry: RepoMappingEntry = {}
  if (form.value.path.trim()) entry.path = form.value.path.trim()
  if (form.value.githubOwner.trim()) entry.githubOwner = form.value.githubOwner.trim()
  if (form.value.githubRepo.trim()) entry.githubRepo = form.value.githubRepo.trim()
  if (form.value.workflow) entry.workflow = form.value.workflow
  if (form.value.description.trim()) entry.description = form.value.description.trim()
  emit('save', name, entry)
}
</script>

<template>
  <div class="repo-inline-form">
    <div class="rif-fields">
      <div class="rif-field">
        <label>Nombre</label>
        <input v-model="form.name" class="rif-input" placeholder="subscriptions" @input="nameError = ''" />
        <span v-if="nameError" class="rif-error">{{ nameError }}</span>
      </div>

      <div class="rif-field">
        <label>Path local</label>
        <AutocompleteSelect
          :model-value="form.path"
          :options="localPathOptions"
          :loading="localReposLoading"
          :error="localReposError"
          placeholder="Buscar repo local…"
          empty-text="Sin repos que coincidan"
          @update:model-value="onPathChange"
        />
      </div>

      <div class="rif-row">
        <div class="rif-field">
          <label>GitHub owner</label>
          <select v-model="form.githubOwner" class="rif-input" :disabled="ownersLoading">
            <option value="">— seleccionar —</option>
            <option
              v-if="form.githubOwner && !owners.some(o => o.login === form.githubOwner)"
              :value="form.githubOwner"
            >{{ form.githubOwner }} (guardado)</option>
            <option v-for="o in owners" :key="o.login" :value="o.login">
              {{ o.login }}{{ o.type === 'user' ? ' (tú)' : '' }}
            </option>
          </select>
          <span v-if="ownersError" class="rif-error">{{ ownersError }}</span>
        </div>

        <div class="rif-field">
          <label>GitHub repo</label>
          <AutocompleteSelect
            v-model="form.githubRepo"
            :options="repos"
            :loading="reposLoading"
            :error="reposError"
            :disabled="!form.githubOwner"
            :placeholder="form.githubOwner ? 'Buscar repo…' : 'Selecciona un owner primero'"
            empty-text="Sin repos que coincidan"
          />
        </div>
      </div>

      <div class="rif-field">
        <label>Workflow</label>
        <select v-model="form.workflow" class="rif-input">
          <option value="">— sin configurar —</option>
          <option value="worktree">Worktree — worktree paralelo en directorio hermano</option>
          <option value="branch">Branch — rama nueva sobre el checkout actual</option>
          <option value="main">Main — commit directo en la rama principal</option>
        </select>
      </div>

      <div class="rif-field">
        <RepoDescriptionField
          v-model="form.description"
          :context-fallback="descriptionContext"
          :context-preview="descriptionContextPreview"
          :ai-disabled="!hasAiContext"
          system-prompt-id="repoDescriptionAssistant"
          placeholder="Breve descripción del repo (qué es, para qué se usa). Se muestra a los agentes vía {project.repos}."
        />
      </div>
    </div>

    <div class="rif-actions">
      <button class="rif-btn-cancel" type="button" @click="emit('cancel')">Cancelar</button>
      <button class="rif-btn-save" type="button" @click="onSave">Guardar</button>
    </div>
  </div>
</template>

<style scoped>
.repo-inline-form {
  padding: 0.85rem 1rem;
  border: 1px solid #bfdbfe;
  border-radius: 8px;
  background: #f0f7ff;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.rif-fields { display: flex; flex-direction: column; gap: 0.65rem; }

.rif-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.rif-field label {
  font-size: 0.78rem;
  font-weight: 600;
  color: #374151;
}

.rif-input {
  padding: 0.38rem 0.6rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.85rem;
  background: #fff;
  color: #1e293b;
  outline: none;
}
.rif-input:focus { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,0.12); }
.rif-input:disabled { background: #f9fafb; color: #6b7280; }

.rif-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.65rem;
}

.rif-error { font-size: 0.73rem; color: #ef4444; }

.rif-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.rif-btn-cancel {
  padding: 0.35rem 0.9rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  font-size: 0.82rem;
  color: #374151;
  cursor: pointer;
}
.rif-btn-cancel:hover { background: #f3f4f6; }

.rif-btn-save {
  padding: 0.35rem 1rem;
  border: none;
  border-radius: 6px;
  background: #2563eb;
  color: #fff;
  font-size: 0.82rem;
  font-weight: 500;
  cursor: pointer;
}
.rif-btn-save:hover { background: #1d4ed8; }
</style>
