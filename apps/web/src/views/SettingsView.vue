<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import AnthropicApiSettingsForm from '../components/AnthropicApiSettingsForm.vue';
import StepConfigModal from '../components/StepConfigModal.vue';
import SystemPromptEditor from '@/components/SystemPromptEditor.vue';
import VariableChipsPanel from '@/components/VariableChipsPanel.vue';
import RepoConfigModal from '../components/RepoConfigModal.vue';
import Toast from '../components/ui/Toast.vue';
import {
  useProvidersStore,
  type AnthropicApiSettings,
  type ProviderId,
  type StepId,
} from '../stores/providers';
import { usePromptsStore, type PhasePrompt } from '../stores/prompts';
import { useToastStore } from '../stores/toast';
import type { RepoMappingEntry, RepoMapping } from '@ia-flow/shared';

const providersStore = useProvidersStore();
const promptsStore = usePromptsStore();
const toastStore = useToastStore();

const STEPS: StepId[] = ['refine-functional', 'refine-technical', 'implement'];

const STEP_INFO: Record<StepId, { label: string; description: string }> = {
  'refine-functional': {
    label: 'Refine Functional',
    description: 'Genera el PRD funcional: user stories, criterios de aceptación y repos impactados.',
  },
  'refine-technical': {
    label: 'Refine Technical',
    description: 'Descompone el PRD funcional en specs técnicas por repo: archivos, contratos de API y tests.',
  },
  implement: {
    label: 'Implement',
    description: 'Lanza Claude Code en cada repo afectado para ejecutar el spec técnico.',
  },
};

const steps = ref<Record<StepId, ProviderId>>({
  'refine-functional': 'anthropic-api',
  'refine-technical': 'anthropic-api',
  implement: 'anthropic-api',
});

const anthropicApi = ref<AnthropicApiSettings>({
  model: '',
  responseLanguage: '',
  thinking: { type: 'enabled', budget_tokens: 0 },
  stream: false,
  systemPrompt: [],
  anthropicVersion: '',
  anthropicBeta: [],
});

const repoMappings = ref<RepoMapping>({});
const saving = ref(false);

// ─── Repo list ────────────────────────────────────────────────────────────────

const repoList = computed(() =>
  Object.entries(repoMappings.value).map(([name, val]) => ({
    name,
    entry: (typeof val === 'string' ? { githubRepo: val } : val) as RepoMappingEntry,
  })),
);

// ─── Step modal ───────────────────────────────────────────────────────────────

const stepModalOpen = ref(false);
const editingStep = ref<StepId | null>(null);

function openStepModal(step: StepId) {
  editingStep.value = step;
  stepModalOpen.value = true;
}

function handleStepSave(step: StepId, provider: ProviderId) {
  steps.value = { ...steps.value, [step]: provider };
  stepModalOpen.value = false;
}

// ─── Repo modal ───────────────────────────────────────────────────────────────

const modalOpen = ref(false);
const editingRepoName = ref<string | undefined>(undefined);
const editingRepoEntry = ref<RepoMappingEntry | undefined>(undefined);

function openAdd() {
  editingRepoName.value = undefined;
  editingRepoEntry.value = undefined;
  modalOpen.value = true;
}

function openEdit(name: string, entry: RepoMappingEntry) {
  editingRepoName.value = name;
  editingRepoEntry.value = entry;
  modalOpen.value = true;
}

function deleteRepo(name: string) {
  const updated = { ...repoMappings.value };
  delete updated[name];
  repoMappings.value = updated;
}

function handleModalSave(newName: string, oldName: string | undefined, entry: RepoMappingEntry) {
  const updated = { ...repoMappings.value };
  if (oldName != null && oldName !== newName) delete updated[oldName];
  updated[newName] = entry;
  repoMappings.value = updated;
  modalOpen.value = false;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const systemPrompt = computed({
  get: () => anthropicApi.value.systemPrompt ?? [],
  set: (value) => {
    anthropicApi.value = { ...anthropicApi.value, systemPrompt: value };
  },
});

// ─── Hydration ────────────────────────────────────────────────────────────────

function hydrateFromStore() {
  const cfg = providersStore.config;
  if (!cfg) return;
  const resolvedSteps = Object.fromEntries(
    Object.entries(cfg.steps).map(([step, val]) => [step, typeof val === 'string' ? val : val.provider]),
  ) as Record<StepId, ProviderId>;
  steps.value = { ...steps.value, ...resolvedSteps };
  anthropicApi.value = {
    model: cfg.anthropicApi.model ?? '',
    responseLanguage: cfg.anthropicApi.responseLanguage ?? '',
    thinking: cfg.anthropicApi.thinking ?? { type: 'enabled', budget_tokens: 0 },
    stream: cfg.anthropicApi.stream ?? false,
    systemPrompt: cfg.anthropicApi.systemPrompt ?? [],
    anthropicVersion: cfg.anthropicApi.anthropicVersion ?? '',
    anthropicBeta: cfg.anthropicApi.anthropicBeta ?? [],
  };
  repoMappings.value = cfg.repoMappings ?? {};
}

onMounted(async () => {
  try {
    await providersStore.fetchConfig();
    hydrateFromStore();
  } catch (e) {
    toastStore.error(`Failed to load config: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await promptsStore.fetch();
  } catch (e) {
    toastStore.error(`Failed to load phase prompts: ${e instanceof Error ? e.message : String(e)}`);
  }
});

watch(() => providersStore.config, hydrateFromStore);

const providers = computed(() => providersStore.providers);
const githubProjectUrl = computed(() => providersStore.githubProjectUrl);

// ─── Provider label helper ────────────────────────────────────────────────────

function providerLabel(id: ProviderId): string {
  return providersStore.providers.find((p) => p.id === id)?.name ?? id;
}

// ─── Phase prompts ────────────────────────────────────────────────────────────

const phasePromptDrafts = ref<Record<StepId, string>>({
  'refine-functional': '',
  'refine-technical': '',
  implement: '',
});

const orderedPhases = computed<PhasePrompt[]>(() => {
  const byStep = new Map(promptsStore.phases.map((p) => [p.step, p]));
  return STEPS.map((s) => byStep.get(s)).filter((p): p is PhasePrompt => Boolean(p));
});

watch(
  () => promptsStore.phases,
  (phases) => {
    for (const p of phases) {
      phasePromptDrafts.value[p.step] = p.prompt;
    }
  },
  { immediate: true, deep: true },
);

function onPhasePromptUpdate(step: StepId, value: string) {
  phasePromptDrafts.value = { ...phasePromptDrafts.value, [step]: value };
}

async function onPhasePromptReset(step: StepId) {
  try {
    await promptsStore.reset(step);
    toastStore.success(`Prompt de ${STEP_INFO[step].label} restaurado`);
  } catch (e) {
    toastStore.error(`Reset failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function savePhasePrompts(): Promise<void> {
  for (const phase of promptsStore.phases) {
    const draft = phasePromptDrafts.value[phase.step];
    if (typeof draft === 'string' && draft !== phase.prompt) {
      await promptsStore.save(phase.step, draft);
    }
  }
}

// ─── Save ─────────────────────────────────────────────────────────────────────

async function onSave() {
  saving.value = true;
  try {
    await providersStore.saveConfig({
      steps: { ...steps.value },
      anthropicApi: {
        ...(providersStore.config?.anthropicApi ?? {}),
        ...anthropicApi.value,
      },
      repoMappings: repoMappings.value,
    });
    await savePhasePrompts();
    toastStore.success('Configuration saved');
  } catch (e) {
    toastStore.error(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="settings-view">

    <!-- ── Header ────────────────────────────────────────────────────────── -->
    <header class="settings-header">
      <div>
        <h1>ia-flow</h1>
        <p class="header-subtitle">
          Pipeline de AI para refinar e implementar tareas de ingeniería en múltiples repos.
        </p>
      </div>
    </header>

    <!-- ── Cómo funciona ─────────────────────────────────────────────────── -->
    <section class="info-section">
      <h2 class="info-title">Cómo funciona</h2>
      <p class="info-desc">
        Crea una tarea con título, descripción y repos afectados. El pipeline la lleva por tres fases
        automáticamente antes de lanzar la implementación.
      </p>

      <div class="pipeline-flow">
        <div class="pipeline-node pipeline-node--start">
          <span class="pipeline-node-icon">📋</span>
          <span class="pipeline-node-label">Tarea</span>
          <span class="pipeline-node-sub">manual</span>
        </div>

        <div v-for="step in STEPS" :key="step" class="pipeline-flow-item">
          <div class="pipeline-arrow">→</div>
          <div class="pipeline-node">
            <span class="pipeline-node-label">{{ STEP_INFO[step].label }}</span>
            <span class="pipeline-node-sub">{{ providerLabel(steps[step]) }}</span>
          </div>
        </div>

        <div class="pipeline-flow-item">
          <div class="pipeline-arrow">→</div>
          <div class="pipeline-node pipeline-node--done">
            <span class="pipeline-node-icon">✓</span>
            <span class="pipeline-node-label">PR abierto</span>
            <span class="pipeline-node-sub">GitHub</span>
          </div>
        </div>
      </div>

      <div class="step-cards">
        <button
          v-for="step in STEPS"
          :key="step"
          type="button"
          class="step-card"
          @click="openStepModal(step)"
        >
          <span class="step-card-name">{{ STEP_INFO[step].label }}</span>
          <span class="step-card-desc">{{ STEP_INFO[step].description }}</span>
          <span class="step-card-provider">{{ providerLabel(steps[step]) }}</span>
        </button>
      </div>
    </section>

    <!-- ── Anthropic API ─────────────────────────────────────────────────── -->
    <section class="settings-section" data-slot="anthropic-form">
      <h2>Anthropic API</h2>
      <p class="section-desc">
        Configuración del cliente de Anthropic. Se aplica a todos los pasos que usen
        <strong>anthropic-api</strong>. El modelo y el presupuesto de pensamiento afectan la
        calidad y el costo de los PRDs generados.
      </p>
      <AnthropicApiSettingsForm v-model="anthropicApi" />
    </section>

    <!-- ── Repos ─────────────────────────────────────────────────────────── -->
    <section class="settings-section" data-slot="repos">
      <div class="section-header">
        <div>
          <h2>Repos</h2>
          <p class="section-desc" style="margin: 0.25rem 0 0;">
            Repos que el pipeline puede tocar. Cada entrada mapea un nombre local a un path en
            disco, un repositorio de GitHub y el modo de trabajo git.
          </p>
        </div>
        <button type="button" class="btn-add-repo" @click="openAdd">+ Add repo</button>
      </div>

      <div class="workflow-legend">
        <span class="wl-item"><span class="wl-badge wl-worktree">worktree</span> — git worktree en directorio hermano (trabajo paralelo seguro)</span>
        <span class="wl-item"><span class="wl-badge wl-branch">branch</span> — rama nueva sobre el checkout actual</span>
        <span class="wl-item"><span class="wl-badge wl-main">main</span> — commit directo en la rama principal</span>
      </div>

      <div v-if="repoList.length === 0" class="repos-empty">
        No hay repos configurados. Agrega uno para empezar.
      </div>

      <ul v-else class="repo-list">
        <li v-for="{ name, entry } in repoList" :key="name" class="repo-card">
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
          <div class="repo-card-actions">
            <button type="button" class="btn-edit" @click="openEdit(name, entry)">Editar</button>
            <button type="button" class="btn-delete" @click="deleteRepo(name)">✕</button>
          </div>
        </li>
      </ul>
    </section>

    <!-- ── System Prompt ─────────────────────────────────────────────────── -->
    <section class="settings-section" data-slot="system-prompt-editor">
      <h2 class="section-title">System Prompt</h2>
      <p class="section-desc">
        Contexto global inyectado en todos los pasos de refinamiento. Usa las variables disponibles
        a la derecha para personalizar el prompt por tarea. Los bloques se envían en orden como
        mensajes de sistema separados.
      </p>
      <div class="system-prompt-layout">
        <SystemPromptEditor v-model="systemPrompt" />
        <VariableChipsPanel />
      </div>
    </section>

    <!-- ── Save ──────────────────────────────────────────────────────────── -->
    <footer class="settings-actions">
      <button
        type="button"
        class="save-button"
        :disabled="saving"
        data-testid="settings-save-button"
        @click="onSave"
      >
        {{ saving ? 'Guardando…' : 'Guardar cambios' }}
      </button>
    </footer>

    <!-- ── Acerca de ──────────────────────────────────────────────────────── -->
    <section class="about-section">
      <div class="about-grid">
        <div class="about-block">
          <h3>Archivos de configuración</h3>
          <ul class="about-list">
            <li>
              <code>apps/server/config/providers.json</code>
              <span>Providers, modelo, system prompt, repo mappings</span>
            </li>
            <li>
              <code>apps/server/config/system-prompt.md</code>
              <span>Prompt de sistema (alternativa al editor)</span>
            </li>
            <li>
              <code>tasks/</code>
              <span>Cola de tareas en YAML — queue / refining / refined / approved</span>
            </li>
          </ul>
        </div>

        <div class="about-block">
          <h3>Variables de entorno</h3>
          <ul class="about-list">
            <li>
              <code>ANTHROPIC_API_KEY</code>
              <span>Requerida para el proveedor anthropic-api</span>
            </li>
            <li>
              <code>CLAUDE_CODE_OAUTH_TOKEN</code>
              <span>Alternativa OAuth al API key</span>
            </li>
            <li>
              <code>GITHUB_TOKEN</code>
              <span>Para crear issues y PRs en GitHub Projects</span>
            </li>
            <li>
              <code>GITHUB_PROJECT_URL</code>
              <span>URL del GitHub Project board que usa el daemon</span>
              <a
                v-if="githubProjectUrl"
                :href="githubProjectUrl"
                target="_blank"
                rel="noopener"
                class="env-link"
              >Abrir proyecto →</a>
              <span v-else class="env-missing">No configurada — daemon deshabilitado</span>
            </li>
          </ul>
        </div>

        <div class="about-block">
          <h3>Providers disponibles</h3>
          <ul class="about-list">
            <li v-for="p in providers" :key="p.id">
              <code>{{ p.id }}</code>
              <span>{{ p.description }}</span>
            </li>
          </ul>
        </div>

        <div class="about-block">
          <h3>Flujo de estados de una tarea</h3>
          <div class="state-flow">
            <span class="state-chip state-queued">queued</span>
            <span class="state-arrow">→</span>
            <span class="state-chip state-refining">refining</span>
            <span class="state-arrow">→</span>
            <span class="state-chip state-refined">refined</span>
            <span class="state-arrow">→ (aprobar)</span>
            <span class="state-chip state-approved">approved</span>
            <span class="state-arrow">→</span>
            <span class="state-chip state-implementing">implementing</span>
          </div>
          <p class="about-note">
            El daemon observa la carpeta <code>tasks/queue/</code> y procesa las tareas automáticamente.
            La aprobación es manual — revisa el PRD generado antes de lanzar la implementación.
          </p>
        </div>
      </div>

      <div class="about-footer">
        <span>ia-flow v1.0.0</span>
        <span class="about-sep">·</span>
        <a href="https://github.com/anthropics/claude-code" target="_blank" rel="noopener">Claude Code docs</a>
        <span class="about-sep">·</span>
        <a href="https://console.anthropic.com" target="_blank" rel="noopener">Anthropic Console</a>
      </div>
    </section>

    <Toast />

    <StepConfigModal
      :open="stepModalOpen"
      :step="editingStep"
      :current-provider="editingStep ? steps[editingStep] : ''"
      :providers="providers"
      :prompt="editingStep ? (phasePromptDrafts[editingStep] ?? '') : ''"
      :default-prompt="editingStep ? (orderedPhases.find((p) => p.step === editingStep)?.defaultPrompt ?? '') : ''"
      :is-customized="editingStep ? (orderedPhases.find((p) => p.step === editingStep)?.isCustomized ?? false) : false"
      :variables="editingStep ? (orderedPhases.find((p) => p.step === editingStep)?.variables ?? []) : []"
      @close="stepModalOpen = false"
      @save="handleStepSave"
      @update:prompt="(step, v) => { onPhasePromptUpdate(step, v); promptsStore.save(step, v); }"
      @reset:prompt="(step) => onPhasePromptReset(step)"
    />

    <RepoConfigModal
      :open="modalOpen"
      :editing-name="editingRepoName"
      :editing-entry="editingRepoEntry"
      @close="modalOpen = false"
      @save="handleModalSave"
    />
  </section>
</template>

<style scoped>
.settings-view {
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  padding-bottom: 3rem;
}

/* ── Header ──────────────────────────────────────────────────────────────── */
.settings-header h1 {
  margin: 0 0 0.25rem;
  font-size: 1.75rem;
}
.header-subtitle {
  margin: 0;
  font-size: 0.9rem;
  color: #6b7280;
}

/* ── Info section ────────────────────────────────────────────────────────── */
.info-section {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 1.25rem;
}
.info-title {
  margin: 0 0 0.4rem;
  font-size: 1rem;
  font-weight: 600;
  color: #1e293b;
}
.info-desc {
  margin: 0 0 1.25rem;
  font-size: 0.875rem;
  color: #64748b;
  line-height: 1.5;
}

/* pipeline flow */
.pipeline-flow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0;
  margin-bottom: 1.25rem;
}
.pipeline-flow-item {
  display: flex;
  align-items: center;
}
.pipeline-arrow {
  color: #94a3b8;
  font-size: 1rem;
  padding: 0 0.35rem;
  flex-shrink: 0;
}
.pipeline-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.5rem 0.9rem;
  background: #fff;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  min-width: 6.5rem;
  text-align: center;
}
.pipeline-node--start {
  border-color: #94a3b8;
  background: #f1f5f9;
}
.pipeline-node--done {
  border-color: #34d399;
  background: #f0fdf4;
}
.pipeline-node-icon {
  font-size: 1rem;
  line-height: 1;
  margin-bottom: 0.2rem;
}
.pipeline-node-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: #1e293b;
  white-space: nowrap;
}
.pipeline-node-sub {
  font-size: 0.68rem;
  color: #94a3b8;
  white-space: nowrap;
}

/* step cards */
.step-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
}
.step-card {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 7px;
  padding: 0.65rem 0.85rem;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.step-card:hover {
  border-color: #93c5fd;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.08);
}
.step-card:focus-visible {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.2);
}
.step-card-name {
  font-size: 0.78rem;
  font-weight: 600;
  color: #334155;
}
.step-card-desc {
  font-size: 0.75rem;
  color: #64748b;
  line-height: 1.4;
}
.step-card-provider {
  margin-top: 0.35rem;
  font-size: 0.7rem;
  color: #2563eb;
  font-weight: 500;
}

/* ── Generic section ─────────────────────────────────────────────────────── */
.settings-section {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 1rem;
}
.settings-section h2,
.section-title {
  margin: 0 0 0.35rem;
  font-size: 1.05rem;
}
.section-desc {
  margin: 0 0 0.9rem;
  font-size: 0.82rem;
  color: #6b7280;
  line-height: 1.5;
}
.section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
}
.section-header h2 {
  margin: 0 0 0.2rem;
  font-size: 1.05rem;
}

/* ── Repos ───────────────────────────────────────────────────────────────── */
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

.workflow-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.25rem;
  margin-bottom: 0.85rem;
  font-size: 0.76rem;
  color: #6b7280;
}
.wl-item { display: flex; align-items: center; gap: 0.4rem; }
.wl-badge {
  font-size: 0.68rem;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
  font-weight: 500;
}
.wl-worktree { background: #dbeafe; color: #1d4ed8; }
.wl-branch   { background: #d1fae5; color: #065f46; }
.wl-main     { background: #fef3c7; color: #92400e; }

.repos-empty {
  font-size: 0.875rem;
  color: #9ca3af;
  padding: 0.5rem 0;
}
.repo-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.repo-card {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  gap: 0.1rem 0.75rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid #e5e7eb;
  border-radius: 7px;
  background: #fafafa;
}
.repo-card-main {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  grid-row: 1;
  grid-column: 1;
}
.repo-name { font-weight: 600; font-size: 0.9rem; }
.workflow-badge {
  font-size: 0.7rem;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
  font-weight: 500;
}
.workflow-badge[data-workflow='worktree'] { background: #dbeafe; color: #1d4ed8; }
.workflow-badge[data-workflow='branch']   { background: #d1fae5; color: #065f46; }
.workflow-badge[data-workflow='main']     { background: #fef3c7; color: #92400e; }
.repo-card-meta {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  grid-row: 2;
  grid-column: 1;
}
.meta-path, .meta-github {
  font-size: 0.78rem;
  color: #6b7280;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 520px;
}
.meta-github { color: #374151; }
.repo-card-actions {
  grid-row: 1 / 3;
  grid-column: 2;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  align-self: center;
}
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
.btn-delete {
  padding: 0.3rem 0.5rem;
  border: 1px solid #fca5a5;
  border-radius: 5px;
  background: #fff;
  color: #ef4444;
  font-size: 0.8rem;
  cursor: pointer;
  line-height: 1;
}
.btn-delete:hover { background: #fef2f2; }

/* ── System prompt ───────────────────────────────────────────────────────── */
.system-prompt-layout {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
}

/* ── Phase prompts ───────────────────────────────────────────────────────── */
.phase-prompts-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

/* ── Save ────────────────────────────────────────────────────────────────── */
.settings-actions {
  display: flex;
  justify-content: flex-end;
}
.save-button {
  padding: 0.5rem 1.4rem;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
  font-size: 0.95rem;
}
.save-button:hover { background: #1d4ed8; }
.save-button:disabled { opacity: 0.6; cursor: not-allowed; }

/* ── About ───────────────────────────────────────────────────────────────── */
.about-section {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  overflow: hidden;
}
.about-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
}
.about-block {
  padding: 1rem 1.1rem;
  border-bottom: 1px solid #f3f4f6;
}
.about-block:nth-child(odd) {
  border-right: 1px solid #f3f4f6;
}
.about-block h3 {
  margin: 0 0 0.6rem;
  font-size: 0.82rem;
  font-weight: 600;
  color: #374151;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.about-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.about-list li {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.about-list code {
  font-size: 0.78rem;
  background: #f3f4f6;
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
  color: #1e293b;
  font-family: 'SF Mono', 'Fira Code', monospace;
  width: fit-content;
}
.about-list span, .about-list em {
  font-size: 0.75rem;
  color: #6b7280;
}

/* state flow */
.state-flow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-bottom: 0.6rem;
}
.state-chip {
  font-size: 0.72rem;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-weight: 500;
}
.state-arrow { font-size: 0.75rem; color: #9ca3af; }
.state-queued      { background: #f3f4f6; color: #374151; }
.state-refining    { background: #fef3c7; color: #92400e; }
.state-refined     { background: #dbeafe; color: #1e40af; }
.state-approved    { background: #d1fae5; color: #065f46; }
.state-implementing { background: #ede9fe; color: #5b21b6; }
.about-note {
  margin: 0;
  font-size: 0.75rem;
  color: #6b7280;
  line-height: 1.5;
}

/* about footer */
.about-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.65rem 1.1rem;
  background: #f9fafb;
  font-size: 0.78rem;
  color: #9ca3af;
}
.about-sep { color: #d1d5db; }
.about-footer a {
  color: #6b7280;
  text-decoration: none;
}
.about-footer a:hover { color: #2563eb; text-decoration: underline; }
.env-link {
  font-size: 0.75rem;
  color: #2563eb;
  text-decoration: none;
  width: fit-content;
}
.env-link:hover { text-decoration: underline; }
.env-missing {
  font-size: 0.73rem;
  color: #f59e0b;
}
</style>
