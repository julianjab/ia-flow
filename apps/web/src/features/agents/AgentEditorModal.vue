<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import AgentActivationSection from '@/features/agents/AgentActivationSection.vue';
import AgentDefinitionSection from '@/features/agents/AgentDefinitionSection.vue';
import OutcomesEditor from '@/features/agents/OutcomesEditor.vue';
import ToolsEditor from '@/features/agents/ToolsEditor.vue';
import CollapsibleSection from '@/ui/CollapsibleSection.vue';
import type { KV } from '@/features/prompts/PromptField.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useProvidersStore } from '@/features/providers/store';
import { useProjectsStore } from '@/features/projects/store';
import type { AgentDefinition, AgentOutcomes, AgentProviderChoice, AgentToolEntry, McpCatalogEntry, SystemPromptDef, SystemPromptRef, WhenCondition } from '@ia-flow/shared';
import { normalizeWhen, type ProjectField } from '@/features/agents/outcomes-serialization';
import { fetchProjectFields, fetchProjectStatuses } from '@/features/projects/sourceApi';
import { useAgentVariableGroups } from '@/composables/useAgentVariableGroups';

interface ToolDef { name: string; description: string }

const props = defineProps<{
  open: boolean;
  agent: AgentDefinition | null;  // null = new agent
  // Scope this editor was opened from — decides whether "Proyecto" is fixed
  // to the active project or shown as "Global". Mirrors AgentesSection's
  // own `scope` prop so activation criteria stay consistent with where the
  // agent will be saved.
  scope?: 'project' | 'global';
  // Optional override for the sysprompt picker. When omitted, falls back to
  // projectConfigStore.config.systemPrompts (legacy single-scope behaviour).
  availableSystemPrompts?: SystemPromptDef[];
}>();

const emit = defineEmits<{
  close: [];
  save: [agent: AgentDefinition];
}>();

const projectConfigStore = useProjectConfigStore();
const providersStore     = useProvidersStore();
const projectsStore      = useProjectsStore();

const activationScope = computed<'project' | 'global'>(() => props.scope ?? 'project');
const activationProjectId = computed(() =>
  activationScope.value === 'project' ? projectsStore.activeProjectId : null,
);
const activationProjectName = computed(() =>
  activationScope.value === 'project' ? (projectsStore.activeProject?.name ?? null) : null,
);

// Field + status catalogs for the Outcomes editor. `Labels` arrives with its
// `options` populated by the server (labels seen across the project's items),
// which is what feeds the label picker de los outcomes.
const outcomesProjectFields = ref<ProjectField[]>([]);
const outcomesStatusOptions = ref<string[]>([]);

async function loadOutcomesCatalogs() {
  const pid = activationProjectId.value;
  if (!pid) {
    outcomesProjectFields.value = [];
    outcomesStatusOptions.value = [];
    return;
  }
  try {
    const res = await fetchProjectFields(pid);
    outcomesProjectFields.value = (res.fields ?? []).map((f) => ({
      name: f.name,
      dataType: f.dataType,
      options: f.options ?? [],
    }));
  } catch { outcomesProjectFields.value = []; }
  try {
    const res = await fetchProjectStatuses(pid);
    outcomesStatusOptions.value = (res.statuses ?? []).map((s) => s.name);
  } catch { outcomesStatusOptions.value = []; }
}

watch(() => [props.open, activationProjectId.value], ([open]) => {
  if (open) void loadOutcomesCatalogs();
});

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';

// ─── Form state ───────────────────────────────────────────────────────────────

const agentId            = ref('');
const provider           = ref('anthropic-api');
// Cuando el agente entrante trae `provider` como array de candidatos (forma
// nueva, opt-in — ver AgentProviderSchema) este editor no lo soporta todavía:
// se preserva sin tocar y se devuelve tal cual al guardar, igual que
// `preservedSystemPromptRefs` hace con las entradas {text} de systemPrompts.
// `provider` (arriba) queda mostrando el primer id como referencia visual,
// con el select deshabilitado — ver AgentDefinitionSection multiProviderLocked.
const preservedMultiProvider = ref<AgentProviderChoice[] | null>(null);
const prompt             = ref('');
const variables          = ref<KV[]>([]);
const tools               = ref<AgentToolEntry[] | undefined>(undefined);
const selectedSysprompts = ref<string[]>([]);
// `AgentDefinition.systemPrompts` puede traer entradas `{text}` inline
// (puestas a mano en un deploy YAML headless) mezcladas con ids — este
// editor solo administra la parte string vía checkboxes, así que preserva
// cualquier `{text}` tal cual para no perderlo al guardar (ver onSave).
const preservedSystemPromptRefs = ref<SystemPromptRef[]>([]);
const providerConfigDraft = ref<Record<string, unknown>>({});
const selectedMcpCatalogIds = ref<string[]>([]);
const availableMcpCatalog = ref<McpCatalogEntry[]>([]);
const availableTools     = ref<ToolDef[]>([]);
const errors             = ref<string[]>([]);
const saving             = ref(false);
// Gate explícito para auto-crear una linked branch en GitHub. Tri-state:
//   null → engine deriva del set de tools · true → siempre · false → nunca.
const requiresBranch = ref<boolean | null>(null);

// ─── Activation criteria (see AgentActivationSchema) ─────────────────────
const repoName = ref<string | null>(null);
const statusName = ref<string | null>(null);
const when = ref<WhenCondition[]>([]);
// Hermano de `when` (ver AgentActivationSchema.whenText) — sin UI dedicada
// todavia, se preserva sin tocar en vez de perderse en cada guardado.
const whenText = ref<string | undefined>(undefined);
const enabled = ref(true);
const allowBlocked = ref(false);

// ─── Outcomes (see AgentOutcomesSchema) — $set:/$labels: strings per slot
const outcomes = ref<AgentOutcomes>({});

const agentVariableGroups = useAgentVariableGroups();

const isNew = computed(() => props.agent === null);
const title = computed(() => isNew.value ? 'Nuevo agente' : `Editar agente — ${props.agent?.id}`);

const providers           = computed(() => providersStore.providers);
const availableSysprompts = computed<SystemPromptDef[]>(() =>
  props.availableSystemPrompts ?? projectConfigStore.config?.systemPrompts ?? [],
);

// ─── Section summaries ────────────────────────────────────────────────────
// Lo que se ve cuando la sección está plegada. Deben responder "¿qué hay acá
// adentro?" sin abrirla — si no hay nada configurado, decirlo explícitamente
// en vez de dejar el resumen vacío.

const activationSummary = computed(() => {
  const parts = [
    statusName.value ?? 'cualquier status',
    repoName.value ?? 'cualquier repo',
  ];
  if (when.value.length) {
    parts.push(`${when.value.length} condición${when.value.length === 1 ? '' : 'es'}`);
  }
  if (allowBlocked.value) parts.push('permite bloqueados');
  if (!enabled.value) parts.push('deshabilitado');
  return parts.join(' · ');
});

const definitionSummary = computed(() => {
  const p = providers.value.find((x) => x.id === provider.value);
  const name = p?.name ?? provider.value;
  return prompt.value.trim() ? name : `${name} · sin prompt`;
});

const toolsSummary = computed(() => {
  const t = (tools.value ?? []).length;
  const m = selectedMcpCatalogIds.value.length;
  if (!t && !m) return 'sin configurar';
  const parts: string[] = [];
  if (t) parts.push(`${t} tool${t === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} MCP`);
  return parts.join(' · ');
});

const outcomesSummary = computed(() => {
  const o = outcomes.value;
  const slots = [
    o.onProcess ? 'process' : null,
    o.onFinish ? 'finish' : null,
    o.onError ? 'error' : null,
  ].filter(Boolean);
  return slots.length ? slots.join(' · ') : 'sin configurar';
});

const advancedSummary = computed(() =>
  requiresBranch.value === null
    ? 'branch: auto'
    : requiresBranch.value
      ? 'branch: siempre'
      : 'branch: nunca',
);

// Seed the first sysprompt for a new agent once the list arrives async.
watch(availableSysprompts, (list) => {
  if (!props.open) return;
  if (!isNew.value) return;
  if (selectedSysprompts.value.length) return;
  if (!list.length) return;
  selectedSysprompts.value = [list[0].id];
});

// ─── Hydrate on open ──────────────────────────────────────────────────────────

watch(() => props.open, async (open) => {
  if (!open) return;
  errors.value = [];
  const a = props.agent;
  if (a) {
    agentId.value             = a.id;
    if (Array.isArray(a.provider)) {
      preservedMultiProvider.value = a.provider;
      provider.value = a.provider[0]?.providerId ?? 'anthropic-api';
    } else {
      preservedMultiProvider.value = null;
      provider.value = a.provider;
    }
    prompt.value              = a.prompt;
    variables.value           = Object.entries(a.variables ?? {}).map(([key, value]) => ({ key, value: typeof value === 'string' ? value : value.value }));
    tools.value                = a.tools ? [...a.tools] : undefined;
    selectedSysprompts.value   = (a.systemPrompts ?? []).filter((r): r is string => typeof r === 'string');
    preservedSystemPromptRefs.value = (a.systemPrompts ?? []).filter((r) => typeof r !== 'string');
    providerConfigDraft.value = { ...(a.providerConfig ?? {}) };
    selectedMcpCatalogIds.value = [...(a.mcpCatalogIds ?? [])];
    requiresBranch.value = a.requiresBranch ?? null;
    repoName.value = a.repoName ?? null;
    statusName.value = a.statusName ?? null;
    when.value = normalizeWhen(a.when);
    whenText.value = a.whenText;
    enabled.value = a.enabled ?? true;
    allowBlocked.value = a.allowBlocked ?? false;
    outcomes.value = {
      onProcess: a.onProcess,
      onFinish: a.onFinish,
      onError: a.onError,
    };
  } else {
    agentId.value             = '';
    preservedMultiProvider.value = null;
    provider.value            = providers.value[0]?.id ?? 'anthropic-api';
    prompt.value              = '';
    variables.value           = [];
    tools.value                = undefined;
    selectedSysprompts.value  = availableSysprompts.value[0]?.id
      ? [availableSysprompts.value[0].id]
      : [];
    preservedSystemPromptRefs.value = [];
    providerConfigDraft.value = {};
    selectedMcpCatalogIds.value = [];
    requiresBranch.value = null;
    repoName.value = null;
    statusName.value = null;
    when.value = [];
    whenText.value = undefined;
    enabled.value = true;
    allowBlocked.value = false;
    outcomes.value = {};
  }

  if (!availableTools.value.length) {
    try {
      const res = await fetch(`${API_BASE}/api/tools`);
      if (res.ok) availableTools.value = await res.json();
    } catch { /* server may not be running */ }
  }

  try {
    const res = await fetch(`${API_BASE}/api/mcp-catalog`);
    if (res.ok) {
      const data = await res.json() as { entries: McpCatalogEntry[] };
      availableMcpCatalog.value = data.entries;
    }
  } catch { /* server may not be running */ }
});

// Reset per-agent providerConfig when the selected provider changes — each
// provider owns its own shape, mixing them makes no sense.
watch(provider, (next, prev) => {
  if (next === prev) return;
  providerConfigDraft.value = {};
});

// ─── Toggles ─────────────────────────────────────────────────────────────────

// El AI-assist de "Definición" sugiere una lista plana de nombres de tool.
// Los mergeamos con lo ya seleccionado, preservando la entry `bash_run` (que
// no es un nombre plano) si existía.
function applyToolNames(names: string[]) {
  const bashEntry = (tools.value ?? []).find((t) => typeof t !== 'string');
  const next: AgentToolEntry[] = [...names];
  if (bashEntry) next.push(bashEntry);
  tools.value = next.length ? next : undefined;
}

function toggleMcpCatalog(id: string) {
  const idx = selectedMcpCatalogIds.value.indexOf(id);
  if (idx === -1) selectedMcpCatalogIds.value.push(id);
  else selectedMcpCatalogIds.value.splice(idx, 1);
}

// ─── Validation & save ────────────────────────────────────────────────────────

// Los tres campos validados (id, provider, prompt) viven en "Definición". Si
// el usuario guarda con esa sección plegada, el error quedaría invisible
// detrás del panel cerrado — así que la abrimos antes de mostrarlo.
const definitionSection = ref<InstanceType<typeof CollapsibleSection> | null>(null);

function kvToRecord(list: KV[]): Record<string, string> {
  return Object.fromEntries(list.filter(kv => kv.key).map(kv => [kv.key, kv.value]));
}

function validate(): boolean {
  errors.value = [];
  if (!agentId.value.trim()) errors.value.push('El id es requerido.');
  if (/\s/.test(agentId.value)) errors.value.push('El id no puede tener espacios.');
  if (!provider.value.trim()) errors.value.push('El provider es requerido.');
  if (!prompt.value.trim()) errors.value.push('El prompt es requerido.');
  if (errors.value.length) definitionSection.value?.forceOpen();
  return errors.value.length === 0;
}

function onSave() {
  if (!validate()) return;
  const agent: AgentDefinition = {
    id: agentId.value.trim(),
    // Un array de candidatos preservado (ver preservedMultiProvider arriba)
    // se devuelve tal cual — este editor no lo modifica.
    provider: preservedMultiProvider.value ?? provider.value,
    prompt: prompt.value,
  };
  // Las entradas {text} preservadas (no editables acá) van primero, seguidas
  // de los ids que sí administra este editor — no reconstruye el orden
  // original si venían intercaladas, pero no pierde ninguna.
  const systemPromptRefs: SystemPromptRef[] = [
    ...preservedSystemPromptRefs.value,
    ...selectedSysprompts.value,
  ];
  if (systemPromptRefs.length) agent.systemPrompts = systemPromptRefs;
  const vars = kvToRecord(variables.value);
  if (Object.keys(vars).length) agent.variables = vars;
  if (tools.value?.length) agent.tools = [...tools.value];
  const pc = buildProviderConfig();
  if (pc) agent.providerConfig = pc;
  if (selectedMcpCatalogIds.value.length)
    agent.mcpCatalogIds = [...selectedMcpCatalogIds.value];
  if (requiresBranch.value !== null) agent.requiresBranch = requiresBranch.value;
  if (repoName.value) agent.repoName = repoName.value;
  if (statusName.value) agent.statusName = statusName.value;
  if (when.value.length) agent.when = when.value;
  if (whenText.value) agent.whenText = whenText.value;
  if (allowBlocked.value) agent.allowBlocked = true;
  agent.enabled = enabled.value;
  Object.assign(agent, outcomes.value);
  emit('save', agent);
}

function buildProviderConfig(): Record<string, unknown> | undefined {
  const draft = providerConfigDraft.value;
  return draft && Object.keys(draft).length > 0 ? { ...draft } : undefined;
}

</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="modal">

      <div class="modal-head">
        <h3>{{ title }}</h3>
        <button class="close-btn" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">

        <!-- Activación primero: responde "¿cuándo corre?" antes que "¿cómo?". -->
        <CollapsibleSection title="Activación" :summary="activationSummary" default-open>
          <AgentActivationSection
            :scope="activationScope"
            :project-id="activationProjectId"
            :project-name="activationProjectName"
            :repo-name="repoName"
            :status-name="statusName"
            :when="when"
            :enabled="enabled"
            :allow-blocked="allowBlocked"
            @update:repo-name="repoName = $event"
            @update:status-name="statusName = $event"
            @update:when="when = $event"
            @update:enabled="enabled = $event"
            @update:allow-blocked="allowBlocked = $event"
          />
        </CollapsibleSection>

        <CollapsibleSection
          ref="definitionSection"
          title="Definición"
          :summary="definitionSummary"
          default-open
        >
          <AgentDefinitionSection
            :agent-id="agentId"
            :is-new="isNew"
            :provider="provider"
            :multi-provider-locked="preservedMultiProvider !== null"
            :providers="providers"
            :provider-config="providerConfigDraft"
            :prompt="prompt"
            :variables="variables"
            :agent-variable-groups="agentVariableGroups"
            :selected-sysprompts="selectedSysprompts"
            :available-sysprompts="availableSysprompts"
            :available-tools="availableTools"
            @update:agent-id="agentId = $event"
            @update:provider="provider = $event"
            @update:provider-config="providerConfigDraft = $event"
            @update:prompt="prompt = $event"
            @update:variables="variables = $event"
            @update:selected-sysprompts="selectedSysprompts = $event"
            @apply-tools="applyToolNames"
          />
        </CollapsibleSection>

        <CollapsibleSection title="Herramientas y MCP" :summary="toolsSummary">
          <ToolsEditor
            :tools="tools"
            @update:tools="tools = $event"
          />

          <div class="field">
            <span class="label">MCP Servers (catálogo)</span>
            <span class="field-hint">
              Entradas del catálogo MCP a inyectar en runtime. Los overrides inline del
              <code>providerConfig.mcpServers</code> tienen precedencia.
              <span v-if="!availableMcpCatalog.length">Sin entradas — creá una en General → MCP Catalog.</span>
            </span>
            <div v-if="availableMcpCatalog.length" class="chip-grid">
              <label
                v-for="entry in availableMcpCatalog"
                :key="entry.id"
                class="chip"
                :class="{ active: selectedMcpCatalogIds.includes(entry.id) }"
                :title="entry.description ?? entry.name"
                @click="toggleMcpCatalog(entry.id)"
              >
                <span class="chip-check">{{ selectedMcpCatalogIds.includes(entry.id) ? '✓' : '' }}</span>
                <span class="chip-mono">{{ entry.id }}</span>
                <span class="chip-mcp-name">{{ entry.name }}</span>
              </label>
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Outcomes" :summary="outcomesSummary">
          <span class="field-hint">
            Asignaciones de campos (<code>$set:</code>) y operaciones de labels
            (<code>$labels:</code>) que este agente aplica al issue al arrancar,
            terminar OK o fallar.
          </span>
          <OutcomesEditor
            v-model="outcomes"
            :project-fields="outcomesProjectFields"
            :status-options="outcomesStatusOptions"
          />
        </CollapsibleSection>

        <CollapsibleSection title="Avanzado" :summary="advancedSummary">
          <div class="field">
            <span class="label">Necesita branch git</span>
            <span class="field-hint">
              Controla si el engine auto-crea (y linkea al issue) una branch
              cuando esta agente arranca sin <code>task.branch</code>. Por default,
              se deriva del set de tools (agentes con
              <code>fs_write</code>/<code>fs_edit</code>/<code>bash_run</code>
              la necesitan). Marcá <b>Sí</b> para agentes que commitean vía GitHub MCP
              sin tener write tools locales; <b>No</b> para desactivarlo aunque tenga write tools.
            </span>
            <div class="tri-toggle">
              <label>
                <input type="radio" :checked="requiresBranch === null" @change="requiresBranch = null" />
                Auto (derivar del set de tools)
              </label>
              <label>
                <input type="radio" :checked="requiresBranch === true" @change="requiresBranch = true" />
                Sí, siempre
              </label>
              <label>
                <input type="radio" :checked="requiresBranch === false" @change="requiresBranch = false" />
                No, nunca
              </label>
            </div>
          </div>
        </CollapsibleSection>

        <div v-if="errors.length" class="error-list">
          <p v-for="e in errors" :key="e">{{ e }}</p>
        </div>

      </div>

      <div class="modal-foot">
        <button class="btn-cancel" @click="emit('close')">Cancelar</button>
        <button class="btn-save" :disabled="saving" @click="onSave">Guardar agente</button>
      </div>

    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 1rem;
}

.modal {
  background: var(--panel);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  width: 100%;
  max-width: 720px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.modal-head h3 { margin: 0; font-size: 1rem; font-weight: 600; color: var(--fg); }

.close-btn {
  background: none;
  border: none;
  font-size: 1rem;
  color: var(--fg-dim);
  cursor: pointer;
  padding: 0.25rem;
  line-height: 1;
}
.close-btn:hover { color: var(--fg-mute); }

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.85rem 1.25rem;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

/* ── Fields ─────────────────────────────────────────────────────────── */
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.label { font-size: 0.82rem; font-weight: 600; color: var(--fg-mute); }
.field-hint { font-size: 0.73rem; color: var(--fg-dim); line-height: 1.4; }

.input {
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border-hi);
  font-size: 0.875rem;
  color: var(--fg);
  background: var(--panel);
  width: 100%;
  box-sizing: border-box;
  outline: none;
}
.input:focus { border-color: var(--accent); }
.input:disabled { background: var(--panel-alt); color: var(--fg-dim); cursor: not-allowed; }
.select { cursor: pointer; }

/* ── Chips ──────────────────────────────────────────────────────────── */
.chip-grid { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.chip {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.65rem;
  border: 1px solid var(--border-hi);
  font-size: 0.78rem;
  color: var(--fg-mute);
  cursor: pointer;
  user-select: none;
  background: var(--panel);
  transition: border-color 0.1s, background 0.1s;
}
.chip:hover { border-color: var(--info); color: var(--info); }
.chip.active { border-color: var(--info); background: var(--panel-hi); color: var(--info); font-weight: 500; }
.chip-check { width: 0.8rem; font-size: 0.72rem; color: var(--info); }
.chip-mono { font-family: var(--font-mono); }
.chip-mcp-name { color: var(--fg-dim); font-size: 0.72rem; }
.field-hint code { background: var(--panel-hi); padding: 0.1rem 0.3rem; font-size: 0.7rem; }
.tri-toggle { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.85rem; }
.tri-toggle label { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; }
.tri-toggle input[type='radio'] { accent-color: var(--info); }

/* ── Buttons ────────────────────────────────────────────────────────── */
.btn-cancel {
  padding: 0.45rem 1.1rem;
  border: 1px solid var(--border-hi);
  background: var(--panel);
  font-size: 0.875rem;
  cursor: pointer;
  color: var(--fg-mute);
}
.btn-cancel:hover { background: var(--panel-alt); }
.btn-save {
  padding: 0.45rem 1.4rem;
  background: var(--accent);
  color: var(--panel);
  border: none;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
}
.btn-save:hover:not(:disabled) { background: var(--accent); }
.btn-save:disabled { opacity: 0.6; cursor: not-allowed; }

/* ── Form-level AI bar ──────────────────────────────────────────────── */

/* ── Provider config (per-agent) ────────────────────────────────────── */
.pc-field :deep(.model-select) {
  padding: 0.45rem 0.65rem;
  font-size: 0.875rem;
  width: 100%;
  flex: none;
}

/* ── Errors ─────────────────────────────────────────────────────────── */
.error-list {
  background: var(--red-bg);
  border: 1px solid var(--danger);
  padding: 0.5rem 0.75rem;
}
.error-list p { margin: 0.15rem 0; font-size: 0.8rem; color: var(--danger); }
</style>
