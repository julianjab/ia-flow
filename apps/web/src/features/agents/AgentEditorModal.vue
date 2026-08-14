<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import AiAssistPanel from '@/features/agents/AiAssistPanel.vue';
import PermissionsEditor from '@/features/agents/PermissionsEditor.vue';
import PromptField from '@/features/prompts/PromptField.vue';
import type { VariableGroup, KV } from '@/features/prompts/PromptField.vue';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useProvidersStore } from '@/features/providers/store';
import type { AgentDefinition, McpCatalogEntry, Permission, PermissionPresetId, SystemPromptDef, VariableDefinition } from '@ia-flow/shared';
import { providerFormFor } from '@/features/agents/providerForms/registry';

interface ToolDef { name: string; description: string }

const props = defineProps<{
  open: boolean;
  agent: AgentDefinition | null;  // null = new agent
  // Optional override for the sysprompt picker. When omitted, falls back to
  // projectConfigStore.config.systemPrompts (legacy single-scope behaviour).
  // The parent knows what's in scope — pass globals only from General, or
  // the overlay (globals + owned) from a project view.
  availableSystemPrompts?: SystemPromptDef[];
}>();

const emit = defineEmits<{
  close: [];
  save: [agent: AgentDefinition];
}>();

const projectConfigStore = useProjectConfigStore();
const providersStore     = useProvidersStore();

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001';

// ─── Form state ───────────────────────────────────────────────────────────────

const agentId            = ref('');
const provider           = ref('anthropic-api');
const prompt             = ref('');
const variables          = ref<KV[]>([]);
const selectedTools      = ref<string[]>([]);
const selectedSysprompts = ref<string[]>([]);
// Opaque per-provider config blob. The per-provider form component owns
// its shape; we hand it in via v-model and get an object back.
const providerConfigDraft = ref<Record<string, unknown>>({});
const selectedMcpCatalogIds = ref<string[]>([]);
const availableMcpCatalog = ref<McpCatalogEntry[]>([]);
const availableTools     = ref<ToolDef[]>([]);
const errors             = ref<string[]>([]);
const saving             = ref(false);
// Gate explícito para auto-crear una linked branch en GitHub. Tri-state:
//   null  → engine deriva del set de tools (default: needs branch si hay
//           write_file/edit_file/run_command).
//   true  → siempre crear branch (útil para agentes que commitean vía MCP
//           sin tener write tools locales, ej. ia-flow-implementer-api).
//   false → nunca crear branch (aunque tenga write tools).
const requiresBranch = ref<boolean | null>(null);
// Issue #58 permission DSL — replaces the ad-hoc tools[] chip grid for
// coding capabilities. `presetId` is the role bundle; `permissions` are
// overrides on top of the preset. `tools[]` stays as legacy allow-list
// for the transition window (renders below with a "legacy" note).
const presetId = ref<PermissionPresetId | undefined>(undefined);
const permissions = ref<Permission[] | undefined>(undefined);

const isNew = computed(() => props.agent === null);
const title = computed(() => isNew.value ? 'Nuevo agente' : `Editar agente — ${props.agent?.id}`);

const providers           = computed(() => providersStore.providers);
const availableSysprompts = computed<SystemPromptDef[]>(() =>
  props.availableSystemPrompts ?? projectConfigStore.config?.systemPrompts ?? [],
);

// If sysprompts arrive after the modal opened (async config), seed the first
// one for a new agent that still has no selection.
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
    provider.value            = a.provider;
    prompt.value              = a.prompt;
    variables.value           = Object.entries(a.variables ?? {}).map(([key, value]) => ({ key, value: typeof value === 'string' ? value : value.value }));
    selectedTools.value       = a.tools ?? [];
    selectedSysprompts.value  = a.systemPrompts ?? [];
    providerConfigDraft.value = { ...(a.providerConfig ?? {}) };
    selectedMcpCatalogIds.value = [...(a.mcpCatalogIds ?? [])];
    requiresBranch.value = a.requiresBranch ?? null;
    presetId.value = a.presetId;
    permissions.value = a.permissions ? [...a.permissions] : undefined;
  } else {
    agentId.value             = '';
    provider.value            = providers.value[0]?.id ?? 'anthropic-api';
    prompt.value              = '';
    variables.value           = [];
    selectedTools.value       = [];
    selectedSysprompts.value  = availableSysprompts.value[0]?.id
      ? [availableSysprompts.value[0].id]
      : [];
    providerConfigDraft.value = {};
    selectedMcpCatalogIds.value = [];
    requiresBranch.value = null;
    presetId.value = undefined;
    permissions.value = undefined;
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

// ─── Form-level AI assist (form-fill mode) ────────────────────────────────
// Owns its own JSON Schema (dynamic — sysprompt/tool enums come from live
// data so the model can only pick real ids). Server forces a `fill_form`
// tool_use with this schema, so we get back a partial object we merge
// non-destructively into the current draft.
const aiOpen = ref(false);
// Prompt returned by fill_form. Routed through PromptField's diff view
// (via :pending-proposal) so the user can review before overwriting.
const pendingPromptProposal = ref<string | null>(null);
const FORM_SCHEMA = computed<Record<string, unknown>>(() => ({
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description:
        'Prompt del agente en markdown. Puede usar variables como {{project.name}}, {{task.title}}, {{variables.MI_KEY}}.',
    },
    systemPrompts: {
      type: 'array',
      description: 'IDs de system prompts a adjuntar en runtime. Solo los del enum.',
      items: {
        type: 'string',
        enum: availableSysprompts.value.map((sp) => sp.id),
      },
    },
    tools: {
      type: 'array',
      description: 'Nombres de tools que el agente puede usar. Vacío = todas.',
      items: {
        type: 'string',
        enum: availableTools.value.map((t) => t.name),
      },
    },
    variables: {
      type: 'object',
      description:
        'Variables snake_case → valor por defecto. Se referencian en el prompt como {{variables.KEY}}.',
      additionalProperties: { type: 'string' },
    },
    providerConfig: {
      type: 'object',
      description:
        'Overrides por-agente del provider. Omitir campos que no aporten valor sobre el default global.',
      properties: {
        model: { type: 'string', description: 'ID del modelo (opus/sonnet/haiku).' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        maxTokens: { type: 'integer', minimum: 1024 },
        taskBudgetTokens: {
          type: 'integer',
          minimum: 20000,
          description: 'Presupuesto total de tokens por corrida (beta task-budgets).',
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
}));

function applyAiFields(fields: Record<string, unknown>) {
  if (typeof fields.prompt === 'string' && fields.prompt.trim()) {
    if (prompt.value.trim() && fields.prompt !== prompt.value) {
      pendingPromptProposal.value = fields.prompt;
    } else {
      prompt.value = fields.prompt;
    }
  }
  if (Array.isArray(fields.systemPrompts)) {
    const validIds = new Set(availableSysprompts.value.map((sp) => sp.id));
    const next = fields.systemPrompts.filter(
      (id): id is string => typeof id === 'string' && validIds.has(id),
    );
    if (next.length) selectedSysprompts.value = next;
  }
  if (Array.isArray(fields.tools)) {
    const validNames = new Set(availableTools.value.map((t) => t.name));
    const next = fields.tools.filter(
      (n): n is string => typeof n === 'string' && validNames.has(n),
    );
    if (next.length) selectedTools.value = next;
  }
  if (fields.variables && typeof fields.variables === 'object') {
    const suggested = fields.variables as Record<string, unknown>;
    const existingKeys = new Set(variables.value.map((kv) => kv.key));
    const merged: KV[] = [...variables.value];
    for (const [k, v] of Object.entries(suggested)) {
      if (!k.trim() || existingKeys.has(k)) continue;
      merged.push({ key: k, value: typeof v === 'string' ? v : String(v ?? '') });
    }
    variables.value = merged;
  }
  if (fields.providerConfig && typeof fields.providerConfig === 'object') {
    providerConfigDraft.value = {
      ...providerConfigDraft.value,
      ...(fields.providerConfig as Record<string, unknown>),
    };
  }
  aiOpen.value = false;
}

// ─── Provider-config helpers ─────────────────────────────────────────────────

// Which subcomponent renders the per-agent config form for the current
// provider. Falls back to JsonProviderForm for providers without a
// dedicated web form (registry decides).
const currentProviderForm = computed(() => providerFormFor(provider.value));

// ─── Toggles ─────────────────────────────────────────────────────────────────

function toggleSysprompt(id: string) {
  const idx = selectedSysprompts.value.indexOf(id);
  if (idx === -1) selectedSysprompts.value.push(id);
  else selectedSysprompts.value.splice(idx, 1);
}

function toggleTool(name: string) {
  const idx = selectedTools.value.indexOf(name);
  if (idx === -1) selectedTools.value.push(name);
  else selectedTools.value.splice(idx, 1);
}

function toggleMcpCatalog(id: string) {
  const idx = selectedMcpCatalogIds.value.indexOf(id);
  if (idx === -1) selectedMcpCatalogIds.value.push(id);
  else selectedMcpCatalogIds.value.splice(idx, 1);
}

// ─── Validation & save ────────────────────────────────────────────────────────

function kvToRecord(list: KV[]): Record<string, string> {
  return Object.fromEntries(list.filter(kv => kv.key).map(kv => [kv.key, kv.value]));
}

function validate(): boolean {
  errors.value = [];
  if (!agentId.value.trim()) errors.value.push('El id es requerido.');
  if (/\s/.test(agentId.value)) errors.value.push('El id no puede tener espacios.');
  if (!provider.value.trim()) errors.value.push('El provider es requerido.');
  if (!prompt.value.trim()) errors.value.push('El prompt es requerido.');
  return errors.value.length === 0;
}

function onSave() {
  if (!validate()) return;
  const agent: AgentDefinition = {
    id: agentId.value.trim(),
    provider: provider.value,
    prompt: prompt.value,
  };
  if (selectedSysprompts.value.length) agent.systemPrompts = [...selectedSysprompts.value];
  const vars = kvToRecord(variables.value);
  if (Object.keys(vars).length) agent.variables = vars;
  if (selectedTools.value.length) agent.tools = [...selectedTools.value];
  if (presetId.value) agent.presetId = presetId.value;
  if (permissions.value?.length) agent.permissions = [...permissions.value];
  const pc = buildProviderConfig();
  if (pc) agent.providerConfig = pc;
  if (selectedMcpCatalogIds.value.length)
    agent.mcpCatalogIds = [...selectedMcpCatalogIds.value];
  if (requiresBranch.value !== null) agent.requiresBranch = requiresBranch.value;
  emit('save', agent);
}

function buildProviderConfig(): Record<string, unknown> | undefined {
  const draft = providerConfigDraft.value;
  return draft && Object.keys(draft).length > 0 ? { ...draft } : undefined;
}

// ─── Variable groups ──────────────────────────────────────────────────────────

const agentVariableGroups = ref<VariableGroup[]>([]);

onMounted(async () => {
  try {
    const res = await fetch(`${API_BASE}/api/variables?context=agent-prompt`);
    if (res.ok) {
      const defs: VariableDefinition[] = await res.json();
      const byGroup = new Map<string, VariableDefinition[]>();
      for (const v of defs) {
        if (!byGroup.has(v.group)) byGroup.set(v.group, []);
        byGroup.get(v.group)!.push(v);
      }
      const order = ['project', 'task', 'context', 'github', 'custom', 'system'];
      agentVariableGroups.value = [...byGroup.entries()]
        .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
        .map(([label, items]) => ({
          label,
          items: items.flatMap(v => {
            const formatted = `{{${v.key}}}`;
            const main = { label: formatted, value: formatted, hint: v.description };
            const subs = v.subfields
              ? Object.entries(v.subfields).map(([sf, meta]) => {
                  const sub = `{{${v.key}.${sf}}}`;
                  return { label: sub, value: sub, hint: meta.description };
                })
              : [];
            return [main, ...subs];
          }),
        }));
    }
  } catch { /* server may not be running */ }
});
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="modal">

      <div class="modal-head">
        <h3>{{ title }}</h3>
        <button class="close-btn" @click="emit('close')">✕</button>
      </div>

      <div class="modal-body">

        <!-- Form-level AI assist: pre-fills the whole form via `fill_form`
             tool_use with our local JSON Schema. -->
        <div class="ai-form-bar">
          <button
            type="button"
            class="btn-ai-form"
            :class="{ active: aiOpen }"
            @click="aiOpen = !aiOpen"
          >
            ✨ IA — Prellenar formulario
          </button>
        </div>
        <AiAssistPanel
          v-if="aiOpen"
          :current-prompt="prompt"
          :agent-id="agentId"
          :agent-variables="variables"
          :agent-system-prompt-ids="selectedSysprompts"
          :template-context="'agent-prompt'"
          :available-system-prompts="availableSysprompts"
          :hide-tool-chips="true"
          :response-schema="FORM_SCHEMA"
          description-optional
          :description-fallback="agentId ? `Editando el agente '${agentId}' (${provider}).` : undefined"
          @result-fields="applyAiFields"
        />

        <!-- System Prompts -->
        <div v-if="availableSysprompts.length" class="field">
          <span class="label">System Prompts</span>
          <span class="field-hint">Sin selección = ninguno extra.</span>
          <div class="chip-grid">
            <label
              v-for="sp in availableSysprompts"
              :key="sp.id"
              class="chip"
              :class="{ active: selectedSysprompts.includes(sp.id) }"
              :title="sp.text"
              @click="toggleSysprompt(sp.id)"
            >
              <span class="chip-check">{{ selectedSysprompts.includes(sp.id) ? '✓' : '' }}</span>
              <span>{{ sp.name }}</span>
            </label>
          </div>
        </div>

        <!-- ID -->
        <div class="field">
          <span class="label">ID <span class="req">*</span></span>
          <span class="field-hint">Sin espacios. Referenciado desde statuses.</span>
          <input v-model="agentId" class="input" placeholder="functional-refiner" :disabled="!isNew" />
        </div>

        <!-- Provider -->
        <div class="field">
          <span class="label">Provider <span class="req">*</span></span>
          <select v-model="provider" class="input select">
            <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name ?? p.id }}</option>
          </select>
        </div>

        <!-- Per-agent provider config — form component chosen by the registry
             from `provider`. Registry falls back to JsonProviderForm for
             providers without a dedicated web form. -->
        <div class="field">
          <span class="label">Configuración del provider (por agente)</span>
          <span class="field-hint">Sobrescribe los defaults globales del provider. Vacío = usa el default global.</span>
          <component
            :is="currentProviderForm"
            v-model="providerConfigDraft"
          />
        </div>

        <!-- Prompt -->
        <div class="field">
          <PromptField
            v-model="prompt"
            v-model:variables="variables"
            :rows="10"
            :variable-groups="agentVariableGroups"
            :agent-id="agentId"
            :required="true"
            template-context="agent-prompt"
            :available-system-prompts="availableSysprompts"
            :pending-proposal="pendingPromptProposal"
            hint="Ruta de archivo (./prompts/mi-prompt.md) o texto inline."
            @clear-pending-proposal="pendingPromptProposal = null"
          />
        </div>

        <!-- Permissions (issue #58) — preset + category tree + bash sub-scopes -->
        <div class="field">
          <span class="label">Permisos</span>
          <span class="field-hint">
            Elegí un preset (reader/refiner/implementer/reviewer/releaser) o
            construí el set desde categorías. Reemplaza el listado plano de
            tools[] para nuevos agentes.
          </span>
          <PermissionsEditor
            v-model:preset-id="presetId"
            v-model:permissions="permissions"
          />
        </div>

        <!-- Tools (legacy — mantenido durante la ventana de migración) -->
        <div class="field">
          <span class="label">Tools (legacy)</span>
          <span class="field-hint">
            Deprecado en favor de Permisos. Sigue funcionando: los nombres
            viejos (<code>run_command</code>, <code>read_file</code>, …) se
            resuelven a los ids nuevos. Sin selección = todas.
          </span>
          <div v-if="availableTools.length" class="chip-grid">
            <label
              v-for="tool in availableTools"
              :key="tool.name"
              class="chip"
              :class="{ active: selectedTools.includes(tool.name) }"
              :title="tool.description"
              @click="toggleTool(tool.name)"
            >
              <span class="chip-check">{{ selectedTools.includes(tool.name) ? '✓' : '' }}</span>
              <span class="chip-mono">{{ tool.name }}</span>
            </label>
          </div>
          <p v-else class="field-hint" style="font-style:italic">Servidor no disponible — inicia el servidor para ver tools.</p>
        </div>

        <!-- MCP Catalog -->
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

        <!-- Requires branch: gate para auto-crear linked branch en GitHub -->
        <div class="field">
          <span class="label">Necesita branch git</span>
          <span class="field-hint">
            Controla si el engine auto-crea (y linkea al issue) una branch
            cuando esta agente arranca sin <code>task.branch</code>. Por default,
            se deriva del set de tools (agentes con
            <code>write_file</code>/<code>edit_file</code>/<code>run_command</code>
            la necesitan). Marcá <b>Sí</b> para agentes que commitean vía GitHub MCP
            sin tener write tools locales; <b>No</b> para desactivarlo aunque tenga write tools.
          </span>
          <div class="tri-toggle">
            <label>
              <input
                type="radio"
                :value="null"
                :checked="requiresBranch === null"
                @change="requiresBranch = null"
              />
              Auto (derivar del set de tools)
            </label>
            <label>
              <input
                type="radio"
                :value="true"
                :checked="requiresBranch === true"
                @change="requiresBranch = true"
              />
              Sí, siempre
            </label>
            <label>
              <input
                type="radio"
                :value="false"
                :checked="requiresBranch === false"
                @change="requiresBranch = false"
              />
              No, nunca
            </label>
          </div>
        </div>

        <!-- Errors -->
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
  border-radius: 12px;
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
.req { color: var(--danger); }
.field-hint { font-size: 0.73rem; color: var(--fg-dim); line-height: 1.4; }

.input {
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
  font-size: 0.875rem;
  color: var(--fg);
  background: var(--panel);
  width: 100%;
  box-sizing: border-box;
  outline: none;
}
.input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
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
  border-radius: 6px;
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
.chip-mono { font-family: 'SF Mono', 'Fira Code', monospace; }
.chip-mcp-name { color: var(--fg-dim); font-size: 0.72rem; }
.field-hint code { background: var(--panel-hi); padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.7rem; }
.tri-toggle { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.85rem; }
.tri-toggle label { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; }
.tri-toggle input[type='radio'] { accent-color: var(--info); }

/* ── Buttons ────────────────────────────────────────────────────────── */
.btn-cancel {
  padding: 0.45rem 1.1rem;
  border: 1px solid var(--border-hi);
  border-radius: 6px;
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
  border-radius: 6px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
}
.btn-save:hover:not(:disabled) { background: var(--accent); }
.btn-save:disabled { opacity: 0.6; cursor: not-allowed; }

/* ── Form-level AI bar ──────────────────────────────────────────────── */
.ai-form-bar { display: flex; justify-content: flex-end; }
.btn-ai-form {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.25rem 0.7rem;
  border: 1px solid var(--border-hi);
  border-radius: 5px;
  background: var(--panel);
  font-size: 0.78rem;
  color: var(--fg-dim);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.btn-ai-form:hover { border-color: var(--magenta); color: var(--magenta); }
.btn-ai-form.active { border-color: var(--magenta); background: var(--panel-hi); color: var(--magenta); }

/* ── Provider config (per-agent) ────────────────────────────────────── */
.pc-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem 1rem;
  padding: 0.75rem;
  background: var(--panel-alt);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.pc-field { display: flex; flex-direction: column; gap: 0.25rem; min-width: 0; }
.pc-label { font-size: 0.78rem; font-weight: 500; color: var(--fg-mute); }
.pc-field :deep(.model-select) {
  padding: 0.45rem 0.65rem;
  font-size: 0.875rem;
  width: 100%;
  flex: none;
}
.pc-warning {
  grid-column: 1 / -1;
  margin: 0;
  padding: 0.4rem 0.6rem;
  font-size: 0.75rem;
  color: var(--warn);
  background: var(--yellow-bg);
  border: 1px solid var(--warn);
  border-radius: 4px;
}

/* ── Errors ─────────────────────────────────────────────────────────── */
.error-list {
  background: var(--red-bg);
  border: 1px solid var(--danger);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}
.error-list p { margin: 0.15rem 0; font-size: 0.8rem; color: var(--danger); }
</style>
