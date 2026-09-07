<script setup lang="ts">
import FullScreen from '@/ui/FullScreen.vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { ref, watch } from 'vue';
import type { RepoMappingEntry, RepoWorkflow, SlackMemberRef, SlackReviewMessage } from '@ia-flow/shared';
import { compactSlackReviewMessage } from '@ia-flow/shared';
import { computed } from 'vue';
import { getLocalRepos, type LocalRepo } from '@/features/repos/api';
import GithubRepoField from '@/features/repos/GithubRepoField.vue';
import RepoDescriptionField from '@/features/repos/RepoDescriptionField.vue';
import SlackReviewFields from '@/ui/SlackReviewFields.vue';
import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue';

interface RepoFormData {
  name: string;
  description: string;
  path: string;
  githubOwner: string;
  githubRepo: string;
  workflow: RepoWorkflow | '';
  slackReviewChannel: string;
  slackReviewers: SlackMemberRef[];
  slackReviewMessage: SlackReviewMessage;
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

const form = ref<RepoFormData>({ name: '', description: '', path: '', githubOwner: '', githubRepo: '', workflow: '', slackReviewChannel: '', slackReviewers: [], slackReviewMessage: {} });
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
        slackReviewChannel: e.slackReviewChannel ?? '',
        slackReviewers: e.slackReviewers ?? [],
        slackReviewMessage: { ...(e.slackReviewMessage ?? {}) },
      };
    } else {
      form.value = { name: '', description: '', path: '', githubOwner: '', githubRepo: '', workflow: '', slackReviewChannel: '', slackReviewers: [], slackReviewMessage: {} };
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
  // Vacío = heredar del proyecto, no "sin canal"/"sin reviewers" — ver
  // resolveSlackReviewTarget. Por eso se omite el campo en vez de mandar ''/[].
  if (form.value.slackReviewChannel.trim()) entry.slackReviewChannel = form.value.slackReviewChannel.trim();
  if (form.value.slackReviewers.length) entry.slackReviewers = form.value.slackReviewers
  const message = compactSlackReviewMessage(form.value.slackReviewMessage);
  if (message) entry.slackReviewMessage = message;
  emit('save', name, props.editingName, entry);
}

// El ComboBox describe cada opción con un objeto; acá la lista son strings
// pelados y el value ES lo que se muestra.
const comboOptions = computed<ComboOption[]>(() => localPathOptions.value.map((value) => ({ value })));
</script>

<template>
  <!-- Bajo --bp-shell esto es una PANTALLA con `←`, no un diálogo de 520px
       centrado en un teléfono de 390 (A3, A5). `FullScreen` trae el backdrop,
       el Escape, el bloqueo de scroll y el pie fijo. -->
  <FullScreen
    :open="open"
    :title="editingName != null ? 'Editar repo' : 'Agregar repo'"
    @close="$emit('close')"
  >
    <template #default>
          <label class="ff-row">
            <span class="uc-label">Nombre *</span>
            <input
              id="repo-name"
              v-model="form.name"
              type="text"
              class="ff-field"
              :class="{ 'ff-field--error': nameError }"
              placeholder="subscriptions"
              @input="nameError = ''"
            />
            <span v-if="nameError" class="ff-error">{{ nameError }}</span>
            <span v-else class="ff-hint">Identificador del repo en tareas</span>
          </label>

          <label class="ff-row">
            <span class="uc-label">Path local</span>
            <ComboBox
              allow-custom
              input-id="repo-path"
              :model-value="form.path"
              :options="comboOptions"
              :loading="localReposLoading"
              :error="localReposError"
              placeholder="Buscar repo local (ej. subscriptions)…"
              empty-text="Sin repos que coincidan"
              @update:model-value="(v) => onPathChange(Array.isArray(v) ? (v[0] ?? '') : v)"
            />
            <span class="ff-hint">Autocompleta desde <code>~/development/lahaus</code> y <code>EXTRA_REPOS</code>. Podés escribir un path manual también.</span>
          </label>

          <label class="ff-row">
            <span class="uc-label">Repo de GitHub</span>
            <GithubRepoField
              id="repo-gh"
              :owner="form.githubOwner"
              :repo="form.githubRepo"
              @update:model-value="onGithubChange"
            />
          </div>

          <label class="ff-row">
            <span class="uc-label">Workflow</span>
            <select id="repo-workflow" v-model="form.workflow" class="ff-field">
              <option value="">— sin configurar —</option>
              <option value="worktree">Worktree — worktree paralelo en directorio hermano</option>
              <option value="branch">Branch — rama nueva sobre el checkout actual</option>
              <option value="main">Main — commit directo en la rama principal</option>
            </select>
          </label>

          <label class="ff-row">
            <SlackReviewFields
              v-model:channel="form.slackReviewChannel"
              v-model:reviewers="form.slackReviewers"
              v-model:message="form.slackReviewMessage"
            />
          </label>

          <label class="ff-row">
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
            <span class="ff-hint">Se muestra a los agentes vía <code v-pre>{{project.repos}}</code>.</span>
          </label>
    </template>

    <template #footer>
      <button type="button" class="btn" @click="$emit('close')">Cancelar</button>
      <button type="button" class="btn btn--primary" @click="onSave">Guardar</button>
    </template>
  </FullScreen>
</template>

<style scoped src="@/ui/form-fields.css"></style>

<style scoped>
/* La caja, el backdrop, el pie fijo y el Escape los pone `FullScreen`; los
   campos, `form-fields.css`. Lo que vivía acá era una copia v3 de las dos
   cosas —radios de 6px, un `#111` en el hover del ✕, un `box-shadow` azul
   fuera de la paleta y sus propios `.btn-primary`/`.btn-secondary`— y se
   borró entera. Queda sólo lo que es de ESTE formulario. */
.field-group {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
/* Bajo --bp-stack una grilla de dos columnas deja ~170px por campo (R5). */
@media (max-width: 640px) {
  .field-group { grid-template-columns: 1fr; }
}
</style>
