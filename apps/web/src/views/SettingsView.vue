<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AnthropicApiSettingsForm from '../components/AnthropicApiSettingsForm.vue';
import StepConfigModal from '../components/StepConfigModal.vue';
import RepoConfigModal from '../components/RepoConfigModal.vue';
import StatusConfigModal from '../components/StatusConfigModal.vue';
import ItemReposModal from '../components/ItemReposModal.vue';
import Toast from '../components/ui/Toast.vue';
import ConfirmDialog from '../components/ui/ConfirmDialog.vue';
import {
  useProvidersStore,
  type AnthropicApiSettings,
  type ProviderId,
  type StepId,
} from '../stores/providers';
import { usePromptsStore, type PhasePrompt } from '../stores/prompts';
import { useProjectConfigStore } from '../stores/project-config';
import { fetchTaskStatuses } from '../api/project-config';
import { useToastStore } from '../stores/toast';
import { getProjectMeta, getProjectItems, updateItemRepos, type ProjectField, type ProjectItem } from '../api/github';
import { getRepoMappings, upsertRepoMapping, deleteRepoMapping } from '../api/repos';
import type {
  RepoMappingEntry,
  RepoMapping,
  AgentDefinition,
  StatusConfig,
  ProjectConfig,
  RepoRegistryEntry,
  SystemPromptDef,
} from '@ia-flow/shared';

const providersStore = useProvidersStore();
const promptsStore = usePromptsStore();
const projectConfigStore = useProjectConfigStore();
const toastStore = useToastStore();

// ─── Confirm dialog ───────────────────────────────────────────────────────────

interface PendingConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
}
const pendingConfirm = ref<PendingConfirm | null>(null);

function askConfirm(c: PendingConfirm) {
  pendingConfirm.value = c;
}
async function runConfirm() {
  const c = pendingConfirm.value;
  if (!c) return;
  pendingConfirm.value = null;
  await c.onConfirm();
}
function cancelConfirm() {
  pendingConfirm.value = null;
}

// ─── Tabs ──────────────────────────────────────────────────────────────────────

type TabId = 'proyecto' | 'agentes' | 'statuses' | 'repos' | 'tareas' | 'archivos';

const TABS: { id: TabId; label: string }[] = [
  { id: 'proyecto',  label: 'Proyecto' },
  { id: 'agentes',   label: 'Agentes' },
  { id: 'statuses',  label: 'Statuses' },
  { id: 'repos',     label: 'Repos' },
  { id: 'tareas',    label: 'Tareas' },
  { id: 'archivos',  label: 'Archivos de config' },
];

const TAB_IDS = TABS.map((t) => t.id) as TabId[];

const route = useRoute();
const router = useRouter();

function tabFromRoute(): TabId {
  const raw = route.params.tab;
  const val = Array.isArray(raw) ? raw[0] : raw;
  return TAB_IDS.includes(val as TabId) ? (val as TabId) : 'proyecto';
}

const activeTab = computed<TabId>({
  get: () => tabFromRoute(),
  set: (tab) => {
    if (tab !== tabFromRoute()) {
      void router.push({ name: 'settings', params: { tab } });
    }
  },
});

watch(
  () => route.params.tab,
  (raw) => {
    const val = Array.isArray(raw) ? raw[0] : raw;
    if (val && !TAB_IDS.includes(val as TabId)) {
      void router.replace({ name: 'settings', params: { tab: 'proyecto' } });
    }
  },
);

// ─── Steps / Providers ────────────────────────────────────────────────────────

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

// ─── Project settings ─────────────────────────────────────────────────────────

const projectName     = ref('');
const projectLanguage = ref('');

// ─── Repo mappings (GitHub repos tab) ─────────────────────────────────────────

const repoMappings = ref<RepoMapping>({});
const saving = ref(false);

const repoList = computed(() =>
  Object.entries(repoMappings.value).map(([name, val]) => ({
    name,
    entry: (typeof val === 'string' ? { githubRepo: val } : val) as RepoMappingEntry,
  })),
);

// ─── Context repos (project-config repos) ────────────────────────────────────

const contextRepoEditOpen = ref(false);
const contextRepoEditName = ref<string | undefined>(undefined);
const contextRepoEditEntry = ref<{ path: string; type: string } | undefined>(undefined);
const REPO_TYPES = ['golang', 'python', 'ruby', 'frontend', 'mobile', 'agent', 'unknown'];
const newContextRepoName = ref('');
const newContextRepoPath = ref('');
const newContextRepoType = ref('unknown');

function openContextRepoAdd() {
  newContextRepoName.value = '';
  newContextRepoPath.value = '';
  newContextRepoType.value = 'unknown';
  contextRepoEditOpen.value = true;
  contextRepoEditName.value = undefined;
  contextRepoEditEntry.value = undefined;
}

function openContextRepoEdit(name: string, entry: RepoRegistryEntry) {
  contextRepoEditName.value = name;
  newContextRepoName.value = name;
  newContextRepoPath.value = entry.path;
  newContextRepoType.value = entry.type;
  contextRepoEditOpen.value = true;
  contextRepoEditEntry.value = { path: entry.path, type: entry.type };
}

async function saveContextRepo() {
  const name = newContextRepoName.value.trim();
  const path = newContextRepoPath.value.trim();
  if (!name || !path) return;
  const current = projectConfigStore.config ?? {};
  const repos = { ...(current.repos ?? {}) };
  if (contextRepoEditName.value && contextRepoEditName.value !== name) {
    delete repos[contextRepoEditName.value];
  }
  repos[name] = { path, type: newContextRepoType.value as RepoRegistryEntry['type'] };
  const updated: ProjectConfig = { ...current, repos };
  try {
    await projectConfigStore.save(updated);
    toastStore.success(`Repo '${name}' guardado`);
    contextRepoEditOpen.value = false;
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function deleteContextRepo(name: string) {
  const current = projectConfigStore.config ?? {};
  const repos = { ...(current.repos ?? {}) };
  delete repos[name];
  const updated: ProjectConfig = { ...current, repos };
  try {
    await projectConfigStore.save(updated);
    toastStore.success(`Repo '${name}' eliminado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const contextRepoList = computed(() =>
  Object.entries(projectConfigStore.config?.repos ?? {}).map(([name, entry]) => ({ name, entry }))
);

// ─── Repo mappings load ───────────────────────────────────────────────────────

async function loadRepoMappings() {
  try {
    const entries = await getRepoMappings();
    repoMappings.value = Object.fromEntries(entries.map(({ name, ...rest }) => [name, rest as RepoMappingEntry]));
  } catch {
    // non-fatal
  }
}

// ─── GitHub Repo modal ────────────────────────────────────────────────────────

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
    if (oldName != null && oldName !== newName) {
      await deleteRepoMapping(oldName);
    }
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
  // repoMappings loaded separately from DB via loadRepoMappings()
}

function hydrateProjectSettings() {
  const cfg = projectConfigStore.config;
  if (!cfg) return;
  projectName.value     = cfg.project?.name ?? '';
  projectLanguage.value = cfg.project?.language ?? '';
}

onMounted(async () => {
  try {
    await providersStore.fetchConfig();
    hydrateFromStore();
  } catch (e) {
    toastStore.error(`Failed to load config: ${e instanceof Error ? e.message : String(e)}`);
  }
  void loadRepoMappings();
  try {
    await promptsStore.fetch();
  } catch (e) {
    toastStore.error(`Failed to load phase prompts: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await projectConfigStore.fetch();
    hydrateProjectSettings();
  } catch (e) {
    toastStore.error(`Failed to load project config: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    taskStatusDirs.value = await fetchTaskStatuses();
  } catch {
    // non-critical, silently skip
  }
});

watch(() => providersStore.config, hydrateFromStore);
watch(() => projectConfigStore.config, hydrateProjectSettings);

const providers = computed(() => providersStore.providers);
const githubProjectUrl = computed(() => providersStore.githubProjectUrl);

function providerLabel(id: ProviderId): string {
  return providersStore.providers.find((p) => p.id === id)?.name ?? id;
}

// ─── System Prompts CRUD ──────────────────────────────────────────────────────

const spEditing = ref<SystemPromptDef | null>(null);
const spDraft   = ref<{ name: string; text: string }>({ name: '', text: '' });
const spPanelOpen = ref(false);

function nameToId(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .split(' ')
    .filter(Boolean)
    .map((w, i) => i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function openNewSp() {
  spDraft.value = { name: '', text: '' };
  spEditing.value = null;
  spPanelOpen.value = true;
}

function openEditSp(sp: SystemPromptDef) {
  spDraft.value = { name: sp.name, text: sp.text };
  spEditing.value = sp;
  spPanelOpen.value = true;
}

function cancelSp() { spPanelOpen.value = false; }

async function saveSp() {
  const name = spDraft.value.name.trim();
  const text = spDraft.value.text.trim();
  if (!name || !text) return;
  const id = spEditing.value ? spEditing.value.id : nameToId(name);
  const current = projectConfigStore.config ?? {};
  const existing = current.systemPrompts ?? [];
  const isEdit = spEditing.value !== null;
  const updated: ProjectConfig = {
    ...current,
    systemPrompts: isEdit
      ? existing.map(sp => sp.id === spEditing.value!.id ? { id, name, text } : sp)
      : [...existing, { id, name, text }],
  };
  await projectConfigStore.save(updated);
  spPanelOpen.value = false;
  toastStore.success(`System prompt '${name}' guardado`);
}

async function deleteSp(id: string) {
  const current = projectConfigStore.config ?? {};
  const updated: ProjectConfig = {
    ...current,
    systemPrompts: (current.systemPrompts ?? []).filter(sp => sp.id !== id),
  };
  await projectConfigStore.save(updated);
  toastStore.success('System prompt eliminado');
}

// ─── Agent CRUD ───────────────────────────────────────────────────────────────

function openNewAgent() {
  void router.push({ name: 'agent-editor', params: { agentId: 'new' } });
}

function openEditAgent(agent: AgentDefinition) {
  void router.push({ name: 'agent-editor', params: { agentId: agent.id } });
}

async function deleteAgent(agentId: string) {
  const current = projectConfigStore.config;
  if (!current) return;
  const updated: ProjectConfig = {
    ...current,
    agents: (current.agents ?? []).filter(a => a.id !== agentId),
  };
  try {
    await projectConfigStore.save(updated);
    toastStore.success(`Agente '${agentId}' eliminado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}


// ─── Status CRUD ──────────────────────────────────────────────────────────────

const statusModalOpen = ref(false);
const editingStatus = ref<StatusConfig | null>(null);
const projectFields = ref<ProjectField[]>([]);
const taskStatusDirs = ref<string[]>([]);

const allStatuses = computed(() => {
  const configMap = new Map((projectConfigStore.config?.statuses ?? []).map(s => [s.name.toLowerCase(), s]));

  // Primary source: Status options from GitHub Project
  const githubStatusField = projectFields.value.find(f => f.name.toLowerCase() === 'status');
  const githubOptions: string[] = githubStatusField?.options ?? [];

  // Secondary source: task dirs (for statuses not in GitHub project)
  const covered = new Set(githubOptions.map(s => s.toLowerCase()));
  const extraFromDirs = taskStatusDirs.value.filter(s => !covered.has(s.toLowerCase()));

  return [...githubOptions, ...extraFromDirs].map(name => ({
    name,
    config: configMap.get(name.toLowerCase()) ?? null,
  }));
});

async function loadProjectFields() {
  try {
    const res = await getProjectMeta();
    projectFields.value = res.fields ?? [];
  } catch {
    projectFields.value = [];
  }
}
onMounted(() => { void loadProjectFields(); });

const agentIds = computed(() => (projectConfigStore.config?.agents ?? []).map(a => a.id));

const statusNameLocked = ref(false);

function openConfigureStatus(name: string, config: StatusConfig | null) {
  editingStatus.value = config ?? ({ name, agents: [] } as StatusConfig);
  statusNameLocked.value = true;
  statusModalOpen.value = true;
}

async function deleteStatus(statusName: string) {
  const current = projectConfigStore.config;
  if (!current) return;
  const updated: ProjectConfig = {
    ...current,
    statuses: (current.statuses ?? []).filter(s => s.name !== statusName),
  };
  try {
    await projectConfigStore.save(updated);
    toastStore.success(`Status '${statusName}' eliminado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function handleStatusSave(status: StatusConfig) {
  const current = projectConfigStore.config ?? {};
  const statuses = current.statuses ?? [];
  const exists = statuses.some(s => s.name.toLowerCase() === status.name.toLowerCase());
  const updated: ProjectConfig = {
    ...current,
    statuses: exists
      ? statuses.map(s => s.name.toLowerCase() === status.name.toLowerCase() ? status : s)
      : [...statuses, status],
  };
  try {
    await projectConfigStore.save(updated);
    statusModalOpen.value = false;
    toastStore.success(`Status '${status.name}' guardado`);
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─── Tareas (GitHub Project items) ───────────────────────────────────────────

const projectItems     = ref<ProjectItem[]>([]);
const itemsLoading     = ref(false);
const itemsError       = ref('');
const reposModalOpen   = ref(false);
const reposModalItem   = ref<ProjectItem | null>(null);
const reposModalSaving = ref(false);

const availableRepoNames = computed(() => {
  const fromGithub  = repoList.value.map(r => r.name);
  const fromContext = contextRepoList.value.map(r => r.name);
  return [...new Set([...fromGithub, ...fromContext])].sort();
});

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

function openReposModal(item: ProjectItem) {
  reposModalItem.value = item;
  reposModalOpen.value = true;
}

function currentReposOf(item: ProjectItem): string[] {
  return item.repos.split(',').map(r => r.trim()).filter(Boolean);
}

async function handleReposSave(repos: string[]) {
  if (!reposModalItem.value) return;
  reposModalSaving.value = true;
  try {
    await updateItemRepos(reposModalItem.value.id, repos);
    // optimistic update
    const idx = projectItems.value.findIndex(i => i.id === reposModalItem.value!.id);
    if (idx !== -1) projectItems.value[idx] = { ...projectItems.value[idx], repos: repos.join(', ') };
    reposModalOpen.value = false;
    toastStore.success('Repos actualizados');
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    reposModalSaving.value = false;
  }
}

watch(
  () => activeTab.value,
  (tab) => { if (tab === 'tareas' && !projectItems.value.length) void loadProjectItems(); },
);

// ─── Save (Proyecto tab) ──────────────────────────────────────────────────────

async function onSaveProyecto() {
  saving.value = true;
  try {
    // Save providers config (repoMappings are saved individually via per-repo API)
    await providersStore.saveConfig({
      steps: { ...steps.value },
      anthropicApi: {
        ...(providersStore.config?.anthropicApi ?? {}),
        ...anthropicApi.value,
      },
    });

    // Save project settings in project-config
    const current = projectConfigStore.config ?? {};
    const updated: ProjectConfig = {
      ...current,
      project: { name: projectName.value, language: projectLanguage.value },
    };
    await projectConfigStore.save(updated);

    await savePhasePrompts();
    toastStore.success('Configuración guardada');
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

    <!-- ── Tab nav ────────────────────────────────────────────────────────── -->
    <nav class="tab-nav">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        type="button"
        class="tab-btn"
        :class="{ 'tab-btn--active': activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </nav>

    <!-- ══════════════════════════════════════════════════════════════════════
         Tab: Proyecto
    ═══════════════════════════════════════════════════════════════════════ -->
    <template v-if="activeTab === 'proyecto'">

      <!-- Project settings -->
      <section class="settings-section">
        <h2>Proyecto</h2>
        <p class="section-desc">Configuración general del proyecto.</p>
        <div class="grid-2">
          <label class="field">
            <span class="field-label">Nombre</span>
            <input v-model="projectName" class="input" placeholder="ia-flow" />
          </label>
          <label class="field">
            <span class="field-label">Idioma</span>
            <input v-model="projectLanguage" class="input" placeholder="español" />
          </label>
        </div>
      </section>

      <!-- Anthropic API -->
      <section class="settings-section" data-slot="anthropic-form">
        <h2>Anthropic API</h2>
        <p class="section-desc">
          Configuración del cliente de Anthropic. Se aplica a todos los pasos que usen
          <strong>anthropic-api</strong>.
        </p>
        <AnthropicApiSettingsForm v-model="anthropicApi" />
      </section>

      <!-- System Prompts Library -->
      <section class="settings-section">
        <div class="section-header">
          <div>
            <h2>System Prompts</h2>
            <p class="section-desc" style="margin: 0.25rem 0 0;">
              Biblioteca de prompts de sistema reutilizables. Selecciónalos desde cada agente para inyectarlos en el contexto.
            </p>
          </div>
          <button type="button" class="btn-add-repo" @click="openNewSp">+ Agregar</button>
        </div>

        <!-- Edit/New form -->
        <div v-if="spPanelOpen" class="sp-form">
          <div class="field">
            <span class="field-label">Nombre</span>
            <input v-model="spDraft.name" class="input" placeholder="Claude Code Identity" />
            <span v-if="spDraft.name" class="field-hint">id: <code>{{ nameToId(spDraft.name) }}</code></span>
          </div>
          <div class="field" style="margin-top:0.5rem">
            <span class="field-label">Texto</span>
            <textarea v-model="spDraft.text" class="input sp-textarea" rows="4" placeholder="You are Claude Code…" />
          </div>
          <div class="sp-form-actions">
            <button class="btn-cancel-sm" @click="cancelSp">Cancelar</button>
            <button class="btn-save-sm" @click="saveSp">Guardar</button>
          </div>
        </div>

        <div v-if="!projectConfigStore.config?.systemPrompts?.length && !spPanelOpen" class="repos-empty">
          No hay system prompts. Haz clic en "+ Agregar" para crear el primero.
        </div>

        <div v-else-if="projectConfigStore.config?.systemPrompts?.length" class="sp-list">
          <div
            v-for="sp in projectConfigStore.config.systemPrompts"
            :key="sp.id"
            class="sp-card"
            @click="openEditSp(sp)"
          >
            <div class="sp-card-top">
              <div>
                <code class="sp-id">{{ sp.id }}</code>
                <span class="sp-name">{{ sp.name }}</span>
              </div>
              <button
                class="btn-delete"
                @click.stop="askConfirm({
                  title: 'Eliminar system prompt',
                  message: `¿Eliminar '${sp.name}'?`,
                  confirmLabel: 'Eliminar',
                  onConfirm: () => deleteSp(sp.id),
                })"
              >✕</button>
            </div>
            <p class="sp-preview">{{ sp.text.slice(0, 120) }}{{ sp.text.length > 120 ? '…' : '' }}</p>
          </div>
        </div>
      </section>

      <!-- Save -->
      <footer class="settings-actions">
        <button
          type="button"
          class="save-button"
          :disabled="saving"
          data-testid="settings-save-button"
          @click="onSaveProyecto"
        >
          {{ saving ? 'Guardando…' : 'Guardar cambios' }}
        </button>
      </footer>

    </template>

    <!-- ══════════════════════════════════════════════════════════════════════
         Tab: Agentes
    ═══════════════════════════════════════════════════════════════════════ -->
    <template v-if="activeTab === 'agentes'">
      <section class="settings-section">
        <div class="section-header">
          <div>
            <h2>Agentes</h2>
            <p class="section-desc" style="margin: 0.25rem 0 0;">
              Biblioteca de definiciones de agentes reutilizables. Cada agente tiene un id, provider,
              prompt y output. Son referenciados por id desde los statuses.
            </p>
          </div>
          <button type="button" class="btn-add-repo" @click="openNewAgent">+ Agregar agente</button>
        </div>

        <div v-if="!projectConfigStore.config?.agents?.length" class="repos-empty">
          No hay agentes definidos. Haz clic en "+ Agregar agente" para crear el primero.
        </div>

        <div v-else class="agent-list">
          <div
            v-for="agent in projectConfigStore.config!.agents"
            :key="agent.id"
            class="agent-card"
            @click="openEditAgent(agent)"
          >
            <div class="agent-card-top">
              <div class="agent-id-row">
                <code class="agent-id">{{ agent.id }}</code>
                <span class="agent-provider-badge">{{ agent.provider }}</span>
              </div>
              <div class="agent-actions">
                <button
                  type="button"
                  class="btn-delete"
                  @click.stop="askConfirm({
                    title: 'Eliminar agente',
                    message: `¿Eliminar el agente '${agent.id}'? Esta acción no se puede deshacer.`,
                    confirmLabel: 'Eliminar',
                    onConfirm: () => deleteAgent(agent.id),
                  })"
                >✕</button>
              </div>
            </div>
            <div class="agent-detail">
              <span class="agent-detail-label">Prompt</span>
              <code class="agent-detail-value">{{ agent.prompt.length > 80 ? agent.prompt.slice(0, 80) + '…' : agent.prompt }}</code>
              <template v-if="agent.variables && Object.keys(agent.variables).length">
                <span class="agent-detail-label">Variables</span>
                <span class="agent-detail-value">{{ Object.entries(agent.variables).map(([k,v]) => `${k}=${v}`).join(', ') }}</span>
              </template>
            </div>
          </div>
        </div>
      </section>
    </template>

    <!-- ══════════════════════════════════════════════════════════════════════
         Tab: Statuses
    ═══════════════════════════════════════════════════════════════════════ -->
    <template v-if="activeTab === 'statuses'">
      <section class="settings-section">
        <h2>Statuses</h2>
        <p class="section-desc">
          Statuses activos en el proyecto. Haz clic en uno para ver o configurar su agente.
        </p>

        <div v-if="!allStatuses.length" class="repos-empty">
          No hay statuses aún. Crea una tarea primero.
        </div>

        <div v-else class="status-cards">
          <div
            v-for="{ name, config: sc } in allStatuses"
            :key="name"
            class="status-card"
            :class="{ 'status-card--configured': !!sc?.agents?.length }"
            @click="openConfigureStatus(name, sc)"
          >
            <div class="status-card-header">
              <span class="status-card-name">{{ name }}</span>
              <button
                v-if="sc"
                type="button"
                class="btn-delete"
                title="Eliminar configuración"
                @click.stop="askConfirm({
                  title: 'Eliminar configuración de status',
                  message: `¿Eliminar la configuración del status '${name}'? Los agentes asignados se perderán.`,
                  confirmLabel: 'Eliminar',
                  onConfirm: () => deleteStatus(name),
                })"
              >✕</button>
            </div>

            <div v-if="sc?.agents?.length" class="status-card-body">
              <div v-for="(entry, i) in sc.agents" :key="i" class="sc-agent-entry">
                <code class="sc-agent-name">{{ entry.agent }}</code>
                <span v-if="entry.when" class="sc-cond-chip">
                  {{ Object.entries(entry.when).map(([k, v]) => `${k}=${v}`).join(', ') }}
                </span>
                <span v-else class="sc-default-badge">default</span>
                <div class="sc-flow">
                  <template v-if="entry.onFinish">
                    <span class="sc-chip sc-chip--finish">→ {{ entry.onFinish }}</span>
                  </template>
                  <template v-if="entry.onError">
                    <span class="sc-chip sc-chip--error">err → {{ entry.onError }}</span>
                  </template>
                </div>
              </div>
            </div>

            <div v-else class="status-card-empty">
              <span>Sin agente configurado</span>
              <span class="sc-add-hint">+ Configurar</span>
            </div>
          </div>
        </div>
      </section>
    </template>

    <!-- ══════════════════════════════════════════════════════════════════════
         Tab: Repos
    ═══════════════════════════════════════════════════════════════════════ -->
    <template v-if="activeTab === 'repos'">

      <!-- Context repos (project-config.yaml) -->
      <section class="settings-section">
        <div class="section-header">
          <div>
            <h2>Repos de contexto</h2>
            <p class="section-desc" style="margin: 0.25rem 0 0;">
              Repos registrados en <code>project-config.yaml</code> para contexto de prompts (path + tipo).
              Los repos no listados aquí se auto-descubren desde <code>~/development</code>.
            </p>
          </div>
          <button type="button" class="btn-add-repo" @click="openContextRepoAdd">+ Agregar repo</button>
        </div>

        <div v-if="!contextRepoList.length" class="repos-empty">
          No hay repos de contexto registrados.
        </div>

        <ul v-else class="repo-list">
          <li v-for="{ name, entry } in contextRepoList" :key="name" class="repo-card">
            <div class="repo-card-main">
              <span class="repo-name">{{ name }}</span>
              <span class="workflow-badge" :data-workflow="entry.type">{{ entry.type }}</span>
            </div>
            <div class="repo-card-meta">
              <span class="meta-path" :title="entry.path">{{ entry.path }}</span>
            </div>
            <div class="repo-card-actions">
              <button type="button" class="btn-edit" @click="openContextRepoEdit(name, entry as any)">Editar</button>
              <button
                type="button"
                class="btn-delete"
                @click="askConfirm({
                  title: 'Eliminar repo de contexto',
                  message: `¿Eliminar el repo de contexto '${name}'?`,
                  confirmLabel: 'Eliminar',
                  onConfirm: () => deleteContextRepo(name),
                })"
              >✕</button>
            </div>
          </li>
        </ul>

        <!-- Inline context repo editor -->
        <div v-if="contextRepoEditOpen" class="context-repo-form">
          <h4>{{ contextRepoEditEntry ? 'Editar repo' : 'Agregar repo' }}</h4>
          <div class="grid-2">
            <label class="field">
              <span class="field-label">Nombre <span class="req">*</span></span>
              <input v-model="newContextRepoName" class="input" placeholder="my-repo" :disabled="!!contextRepoEditEntry" />
            </label>
            <label class="field">
              <span class="field-label">Tipo</span>
              <select v-model="newContextRepoType" class="input select">
                <option v-for="t in REPO_TYPES" :key="t" :value="t">{{ t }}</option>
              </select>
            </label>
          </div>
          <label class="field" style="margin-top: 0.65rem;">
            <span class="field-label">Path <span class="req">*</span></span>
            <input v-model="newContextRepoPath" class="input" placeholder="~/development/my-repo" />
          </label>
          <div class="form-actions" style="margin-top: 0.65rem;">
            <button type="button" class="btn-cancel" @click="contextRepoEditOpen = false">Cancelar</button>
            <button type="button" class="btn-save-small" @click="saveContextRepo">Guardar</button>
          </div>
        </div>
      </section>

      <!-- GitHub repos (providers.json) -->
      <section class="settings-section">
        <div class="section-header">
          <div>
            <h2>Repos de GitHub</h2>
            <p class="section-desc" style="margin: 0.25rem 0 0;">
              Repos que el pipeline puede tocar en GitHub. Cada entrada mapea un nombre local
              a un repositorio de GitHub y el modo de trabajo git.
            </p>
          </div>
          <button type="button" class="btn-add-repo" @click="openAdd">+ Add repo</button>
        </div>

        <div class="workflow-legend">
          <span class="wl-item"><span class="wl-badge wl-worktree">worktree</span> — git worktree en directorio hermano</span>
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
              <button
                type="button"
                class="btn-delete"
                @click="askConfirm({
                  title: 'Eliminar repo de GitHub',
                  message: `¿Eliminar el mapping del repo '${name}'? El pipeline dejará de poder tocarlo.`,
                  confirmLabel: 'Eliminar',
                  onConfirm: () => deleteRepo(name),
                })"
              >✕</button>
            </div>
          </li>
        </ul>

        <footer class="settings-actions" style="margin-top: 1rem;">
          <button
            type="button"
            class="save-button"
            :disabled="saving"
            @click="onSaveProyecto"
          >
            {{ saving ? 'Guardando…' : 'Guardar repos GitHub' }}
          </button>
        </footer>
      </section>

    </template>

    <!-- ══════════════════════════════════════════════════════════════════════
         Tab: Tareas
    ═══════════════════════════════════════════════════════════════════════ -->
    <template v-if="activeTab === 'tareas'">
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
                <span
                  v-for="r in currentReposOf(item)"
                  :key="r"
                  class="task-repo-chip"
                >{{ r }}</span>
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

    <!-- ══════════════════════════════════════════════════════════════════════
         Tab: Archivos de config
    ═══════════════════════════════════════════════════════════════════════ -->
    <template v-if="activeTab === 'archivos'">
      <section class="about-section">
        <div class="about-grid">
          <div class="about-block">
            <h3>Archivos de configuración</h3>
            <ul class="about-list">
              <li>
                <code>apps/server/config/project-config.yaml</code>
                <span>Agentes reutilizables, statuses del flujo, registry de repos</span>
              </li>
              <li>
                <code>apps/server/config/providers.json</code>
                <span>Provider global, modelo, system prompt, repo mappings GitHub</span>
              </li>
              <li>
                <code>apps/server/config/prompts/</code>
                <span>Archivos de prompt referenciados desde project-config.yaml</span>
              </li>
              <li>
                <code>tasks/</code>
                <span>Cola de tareas en YAML — un dir por status</span>
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
                <span v-else class="env-missing">No configurada — daemon GitHub deshabilitado</span>
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
            </div>
            <p class="about-note">
              El daemon observa <code>tasks/</code> y ejecuta el agente configurado para cada status.
              Los statuses son dinámicos — cualquier valor en <code>project-config.yaml</code> crea su
              propio directorio automáticamente.
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
    </template>

    <Toast />

    <ConfirmDialog
      :open="pendingConfirm != null"
      :title="pendingConfirm?.title"
      :message="pendingConfirm?.message ?? ''"
      :confirm-label="pendingConfirm?.confirmLabel"
      danger
      @confirm="runConfirm"
      @cancel="cancelConfirm"
    />

    <StatusConfigModal
      :open="statusModalOpen"
      :status-config="editingStatus"
      :agent-ids="agentIds"
      :project-fields="projectFields"
      :name-locked="statusNameLocked"
      @close="statusModalOpen = false"
      @save="handleStatusSave"
    />

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

/* ── Tabs ────────────────────────────────────────────────────────────────── */
.tab-nav {
  display: flex;
  border-bottom: 2px solid #e5e7eb;
  gap: 0;
}
.tab-btn {
  padding: 0.55rem 1.1rem;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  font-size: 0.875rem;
  font-weight: 500;
  color: #6b7280;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  white-space: nowrap;
}
.tab-btn:hover { color: #374151; }
.tab-btn--active {
  color: #2563eb;
  border-bottom-color: #2563eb;
}

/* ── Generic section ─────────────────────────────────────────────────────── */
.settings-section {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 1rem;
}
.settings-section h2 {
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

/* ── Grid ────────────────────────────────────────────────────────────────── */
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.65rem 1rem;
}
.field { display: flex; flex-direction: column; gap: 0.25rem; }
.field-label { font-size: 0.8rem; font-weight: 500; color: #374151; }
.req { color: #ef4444; }
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
.input:disabled { background: #f9fafb; color: #6b7280; cursor: not-allowed; }
.select { cursor: pointer; }

/* ── Buttons ─────────────────────────────────────────────────────────────── */
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
.btn-cancel {
  padding: 0.35rem 0.85rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  font-size: 0.83rem;
  cursor: pointer;
  color: #374151;
}
.btn-cancel:hover { background: #f9fafb; }
.btn-save-small {
  padding: 0.35rem 0.85rem;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 0.83rem;
  font-weight: 500;
  cursor: pointer;
}
.btn-save-small:hover { background: #1d4ed8; }
.form-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }

/* ── Repos ───────────────────────────────────────────────────────────────── */
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
  background: #f3f4f6;
  color: #374151;
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

/* ── Context repo inline form ─────────────────────────────────────────────── */
.context-repo-form {
  margin-top: 0.75rem;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 0.9rem 1rem;
  background: #f8fafc;
}
.context-repo-form h4 { margin: 0 0 0.65rem; font-size: 0.88rem; }


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
.about-block:nth-child(odd) { border-right: 1px solid #f3f4f6; }
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
.about-list li { display: flex; flex-direction: column; gap: 0.1rem; }
.about-list code {
  font-size: 0.78rem;
  background: #f3f4f6;
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
  color: #1e293b;
  font-family: 'SF Mono', 'Fira Code', monospace;
  width: fit-content;
}
.about-list span { font-size: 0.75rem; color: #6b7280; }

.state-flow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-bottom: 0.6rem;
}
.state-chip { font-size: 0.72rem; padding: 0.15rem 0.5rem; border-radius: 4px; font-weight: 500; }
.state-arrow { font-size: 0.75rem; color: #9ca3af; }
.state-queued      { background: #f3f4f6; color: #374151; }
.state-refining    { background: #fef3c7; color: #92400e; }
.state-refined     { background: #dbeafe; color: #1e40af; }
.state-approved    { background: #d1fae5; color: #065f46; }
.about-note { margin: 0; font-size: 0.75rem; color: #6b7280; line-height: 1.5; }

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
.about-footer a { color: #6b7280; text-decoration: none; }
.about-footer a:hover { color: #2563eb; text-decoration: underline; }
.env-link { font-size: 0.75rem; color: #2563eb; text-decoration: none; width: fit-content; }
.env-link:hover { text-decoration: underline; }
.env-missing { font-size: 0.73rem; color: #f59e0b; }

/* ── Status cards ────────────────────────────────────────────────────────── */
.status-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
  margin-top: 0.25rem;
}
.status-card {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  background: #fafafa;
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s, background 0.12s;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-height: 90px;
}
.status-card:hover { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.08); background: #fff; }
.status-card--configured { background: #fff; border-color: #d1d5db; }
.status-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.status-card-name {
  font-size: 0.88rem;
  font-weight: 700;
  color: #1e293b;
}
.status-card-body { display: flex; flex-direction: column; gap: 0.4rem; }
.status-card-empty {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  flex: 1;
  justify-content: center;
}
.status-card-empty > span:first-child { font-size: 0.75rem; color: #9ca3af; }
.sc-add-hint { font-size: 0.72rem; color: #2563eb; font-weight: 500; }
.sc-flow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.sc-arrow { color: #9ca3af; font-size: 0.72rem; }
.sc-sep   { color: #d1d5db; font-size: 0.72rem; margin: 0 0.1rem; }
.sc-chip {
  font-size: 0.68rem;
  font-weight: 600;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
}
.sc-chip--process { background: #fef3c7; color: #92400e; }
.sc-chip--finish  { background: #d1fae5; color: #065f46; }
.sc-chip--error   { background: #fee2e2; color: #991b1b; font-weight: 400; }
.sc-agent-entry {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
}
.sc-agent-name {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.72rem;
  color: #1d4ed8;
  background: #dbeafe;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-cond-chip {
  font-size: 0.65rem;
  background: #ede9fe;
  color: #5b21b6;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
}
.sc-default-badge {
  font-size: 0.65rem;
  background: #d1fae5;
  color: #065f46;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  font-weight: 600;
}

/* ── Agents ──────────────────────────────────────────────────────────────── */
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.agent-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 0.75rem 0.9rem;
  background: #fafafa;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s, background 0.12s;
}
.agent-card:hover { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.08); background: #fff; }
.agent-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.agent-id-row { display: flex; align-items: center; gap: 0.5rem; flex: 1; }
.agent-id {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.85rem;
  font-weight: 600;
  color: #1e293b;
}
.agent-provider-badge {
  font-size: 0.68rem;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
  background: #dbeafe;
  color: #1d4ed8;
  font-weight: 500;
}
.agent-actions { display: flex; align-items: center; gap: 0.35rem; flex-shrink: 0; }
.agent-flow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.3rem;
  flex: 1;
}
.agent-flow-arrow { color: #9ca3af; font-size: 0.8rem; }
.agent-flow-sep { color: #d1d5db; margin: 0 0.25rem; }
.agent-status {
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
}
.agent-status--trigger  { background: #f3f4f6; color: #374151; }
.agent-status--process  { background: #fef3c7; color: #92400e; }
.agent-status--finish   { background: #d1fae5; color: #065f46; }
.agent-status--error    { background: #fee2e2; color: #991b1b; font-weight: 400; }
.agent-detail {
  display: grid;
  grid-template-columns: 5rem 1fr;
  gap: 0.15rem 0.5rem;
  font-size: 0.78rem;
  align-items: baseline;
}
.agent-detail-label { color: #9ca3af; }
.agent-detail-value {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  color: #1e293b;
  word-break: break-all;
}
.agent-variants { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.agent-variants-label { font-size: 0.72rem; color: #9ca3af; }
.agent-variant-chip {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  background: #ede9fe;
  border-radius: 4px;
  padding: 0.15rem 0.5rem;
  font-size: 0.7rem;
}
.variant-when { color: #5b21b6; font-weight: 600; }
.variant-prompt { color: #6d28d9; }

/* ── System Prompts ───────────────────────────────────────────────── */
.sp-form {
  background: #f8fafc;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 1rem;
  margin-bottom: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.sp-form-row { display: flex; gap: 0.75rem; }
.sp-textarea { resize: vertical; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.8rem; }
.sp-form-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.25rem; }
.btn-cancel-sm {
  padding: 0.3rem 0.85rem;
  border: 1px solid #d1d5db;
  border-radius: 5px;
  background: #fff;
  font-size: 0.8rem;
  cursor: pointer;
  color: #374151;
}
.btn-save-sm {
  padding: 0.3rem 0.85rem;
  border: none;
  border-radius: 5px;
  background: #2563eb;
  color: #fff;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
}
.btn-save-sm:hover { background: #1d4ed8; }

.sp-list { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.25rem; }
.sp-card {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 0.65rem 0.85rem;
  cursor: pointer;
  background: #fafafa;
  transition: border-color 0.15s, background 0.15s;
}
.sp-card:hover { border-color: #2563eb; background: #fff; }
.sp-card-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.3rem; }
.sp-id { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.75rem; color: #6366f1; background: #eef2ff; padding: 0.1rem 0.35rem; border-radius: 4px; margin-right: 0.5rem; }
.sp-name { font-size: 0.82rem; font-weight: 500; color: #111827; }
.sp-preview { margin: 0; font-size: 0.75rem; color: #6b7280; font-family: 'SF Mono', 'Fira Code', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ── Tareas tab ───────────────────────────────────────────────────────── */
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
