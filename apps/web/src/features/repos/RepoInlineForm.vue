<script setup lang="ts">
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { ref, watch, computed } from 'vue';
import type { RepoMappingEntry, RepoWorkflow, SlackMemberRef } from '@ia-flow/shared';
import { getLocalRepos, type LocalRepo } from '@/features/repos/api';
import GithubRepoField from '@/features/repos/GithubRepoField.vue';
import RepoDescriptionField from '@/features/repos/RepoDescriptionField.vue';
import AutocompleteSelect from '@/ui/AutocompleteSelect.vue';
import SlackReviewFields from '@/ui/SlackReviewFields.vue';

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
  slackReviewChannel: string
  slackReviewers: SlackMemberRef[]
}

const form = ref<Form>({
  name: props.name,
  description: props.entry.description ?? '',
  path: props.entry.path ?? '',
  githubOwner: props.entry.githubOwner ?? '',
  githubRepo: props.entry.githubRepo ?? '',
  workflow: props.entry.workflow ?? '',
  slackReviewChannel: props.entry.slackReviewChannel ?? '',
  slackReviewers: props.entry.slackReviewers ?? [],
})
const nameError = ref('')

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
  )
  // Match the shape the seed prompt (repoDescriptionAssistant) expects:
  // a bare JSON with { name, path, githubOwner, githubRepo }. No behavioural
  // guidance here — the system prompt already handles with/without tools.
  return `Repo:\n${payload}`
})

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

const aiRepoContexts = computed(() => {
  const name = form.value.name.trim() || 'repo'
  const path = form.value.path.trim()
  return path ? [{ name, path }] : []
})

const AI_DEFAULT_TOOLS = ['read_file', 'list_dir', 'grep_files']

// Reset form when props change (different card expanded)
watch(() => props.name, () => {
  form.value = {
    name: props.name,
    description: props.entry.description ?? '',
    path: props.entry.path ?? '',
    githubOwner: props.entry.githubOwner ?? '',
    githubRepo: props.entry.githubRepo ?? '',
    workflow: props.entry.workflow ?? '',
    slackReviewChannel: props.entry.slackReviewChannel ?? '',
    slackReviewers: props.entry.slackReviewers ?? [],
  }
  nameError.value = ''
}, { immediate: true })

// ── Repo local ─────────────────────────────────────────────────────────────
// El autocomplete de owner/repo de GitHub vive en GithubRepoField, junto con
// sus llamadas a la API.

const localRepos = ref<LocalRepo[]>([])
const localReposLoading = ref(false)
const localReposError = ref('')

const localPathOptions = computed(() => localRepos.value.map(r => r.path))

async function loadLocalRepos() {
  localReposLoading.value = true
  localReposError.value = ''
  try {
    const res = await getLocalRepos()
    localRepos.value = res.repos ?? []
    if (res.error) localReposError.value = res.error
  } catch (e) {
    localReposError.value = extractErrorMessage(e)
  } finally {
    localReposLoading.value = false
  }
}

// Load data on mount
void loadLocalRepos()

function onGithubChange(next: { owner: string; repo: string }) {
  form.value.githubOwner = next.owner
  form.value.githubRepo = next.repo
}

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
  // Vacío = heredar del proyecto, no "sin canal"/"sin reviewers" — ver
  // resolveSlackReviewTarget. Por eso se omite el campo en vez de mandar ''/[].
  if (form.value.slackReviewChannel.trim()) entry.slackReviewChannel = form.value.slackReviewChannel.trim()
  if (form.value.slackReviewers.length) entry.slackReviewers = form.value.slackReviewers
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

      <div class="rif-field">
        <label>Repo de GitHub</label>
        <!-- key por nombre: esta instancia se reusa al expandir otra tarjeta, y
             un slug a medio tipear (que emite owner/repo vacíos) no se
             distingue de la tarjeta nueva que también los tiene vacíos. -->
        <GithubRepoField
          :key="name"
          :owner="form.githubOwner"
          :repo="form.githubRepo"
          @update:model-value="onGithubChange"
        />
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
        <SlackReviewFields
          v-model:channel="form.slackReviewChannel"
          v-model:reviewers="form.slackReviewers"
        />
      </div>

      <div class="rif-field">
        <RepoDescriptionField
          v-model="form.description"
          :context-fallback="descriptionContext"
          :context-preview="descriptionContextPreview"
          :ai-disabled="!hasAiContext"
          :default-tools="AI_DEFAULT_TOOLS"
          :repo-contexts="aiRepoContexts"
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
  border: 1px solid var(--info);
  border-radius: 8px;
  background: var(--panel-alt);
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
  color: var(--fg-mute);
}

.rif-input {
  padding: 0.38rem 0.6rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-size: 0.85rem;
  background: var(--panel);
  color: var(--fg);
  outline: none;
}
.rif-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(37,99,235,0.12); }
.rif-input:disabled { background: var(--panel-alt); color: var(--fg-dim); }

.rif-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.65rem;
}

.rif-error { font-size: 0.73rem; color: var(--danger); }
.rif-hint { font-size: var(--fs-micro); color: var(--fg-dimmer); }

.rif-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.rif-btn-cancel {
  padding: 0.35rem 0.9rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  background: var(--panel);
  font-size: 0.82rem;
  color: var(--fg-mute);
  cursor: pointer;
}
.rif-btn-cancel:hover { background: var(--panel-hi); }

.rif-btn-save {
  padding: 0.35rem 1rem;
  border: none;
  border-radius: 6px;
  background: var(--accent);
  color: var(--panel);
  font-size: 0.82rem;
  font-weight: 500;
  cursor: pointer;
}
.rif-btn-save:hover { background: var(--accent); }
</style>
