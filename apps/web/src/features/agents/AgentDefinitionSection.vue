<script setup lang="ts">
// "Definición" section of the agent editor — id, provider (+ its per-agent
// config form), prompt, system prompts, and the form-level AI assist bar
// that pre-fills all of the above (plus tools, forwarded up via
// `apply-tools` since Tools lives in a different accordion section).
// Extracted out of AgentEditorModal to keep that file under the 300-line
// ceiling (see apps/web/CLAUDE.md).

import { computed, ref } from 'vue'
import AiAssistPanel from '@/features/agents/AiAssistPanel.vue'
import PromptField from '@/features/prompts/PromptField.vue'
import type { VariableGroup, KV } from '@/features/prompts/PromptField.vue'
import { providerFormFor } from '@/features/agents/providerForms/registry'
import ProviderChoicesEditor from '@/features/agents/ProviderChoicesEditor.vue'
import type { AgentProviderChoice, SystemPromptDef } from '@ia-flow/shared'

interface ToolDef { name: string; description: string }
interface ProviderOption { id: string; name?: string }

const props = defineProps<{
  agentId: string
  isNew: boolean
  /** Siempre un array — 1 candidato es el caso común, 2+ agrega orden de
   *  fallback (ver AgentProviderSchema). AgentEditorModal decide si lo que
   *  se guarda es un string plano o el array completo. */
  providerChoices: AgentProviderChoice[]
  providers: ProviderOption[]
  providerConfig: Record<string, unknown>
  prompt: string
  variables: KV[]
  agentVariableGroups: VariableGroup[]
  selectedSysprompts: string[]
  availableSysprompts: SystemPromptDef[]
  availableTools: ToolDef[]
}>()

const emit = defineEmits<{
  'update:agentId': [value: string]
  'update:providerChoices': [value: AgentProviderChoice[]]
  'update:providerConfig': [value: Record<string, unknown>]
  'update:prompt': [value: string]
  'update:variables': [value: KV[]]
  'update:selectedSysprompts': [value: string[]]
  'apply-tools': [names: string[]]
}>()

const primaryProviderId = computed(() => props.providerChoices[0]?.providerId ?? '')
const currentProviderForm = computed(() => providerFormFor(primaryProviderId.value))

function toggleSysprompt(id: string) {
  const next = props.selectedSysprompts.includes(id)
    ? props.selectedSysprompts.filter((s) => s !== id)
    : [...props.selectedSysprompts, id]
  emit('update:selectedSysprompts', next)
}

// ─── Form-level AI assist (form-fill mode) ────────────────────────────────
const aiOpen = ref(false)
const pendingPromptProposal = ref<string | null>(null)

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
      items: { type: 'string', enum: props.availableSysprompts.map((sp) => sp.id) },
    },
    tools: {
      type: 'array',
      description: 'Nombres de tools que el agente puede usar. Vacío = todas.',
      items: { type: 'string', enum: props.availableTools.map((t) => t.name) },
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
}))

function applyAiFields(fields: Record<string, unknown>) {
  if (typeof fields.prompt === 'string' && fields.prompt.trim()) {
    if (props.prompt.trim() && fields.prompt !== props.prompt) {
      pendingPromptProposal.value = fields.prompt
    } else {
      emit('update:prompt', fields.prompt)
    }
  }
  if (Array.isArray(fields.systemPrompts)) {
    const validIds = new Set(props.availableSysprompts.map((sp) => sp.id))
    const next = fields.systemPrompts.filter(
      (id): id is string => typeof id === 'string' && validIds.has(id),
    )
    if (next.length) emit('update:selectedSysprompts', next)
  }
  if (Array.isArray(fields.tools)) {
    const validNames = new Set(props.availableTools.map((t) => t.name))
    const next = fields.tools.filter(
      (n): n is string => typeof n === 'string' && validNames.has(n),
    )
    if (next.length) emit('apply-tools', next)
  }
  if (fields.variables && typeof fields.variables === 'object') {
    const suggested = fields.variables as Record<string, unknown>
    const existingKeys = new Set(props.variables.map((kv) => kv.key))
    const merged: KV[] = [...props.variables]
    for (const [k, v] of Object.entries(suggested)) {
      if (!k.trim() || existingKeys.has(k)) continue
      merged.push({ key: k, value: typeof v === 'string' ? v : String(v ?? '') })
    }
    emit('update:variables', merged)
  }
  if (fields.providerConfig && typeof fields.providerConfig === 'object') {
    emit('update:providerConfig', {
      ...props.providerConfig,
      ...(fields.providerConfig as Record<string, unknown>),
    })
  }
  aiOpen.value = false
}
</script>

<template>
  <div class="ads">

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
      :description-fallback="agentId ? `Editando el agente '${agentId}' (${primaryProviderId}).` : undefined"
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
      <input
        :value="agentId"
        class="input"
        placeholder="functional-refiner"
        :disabled="!isNew"
        @input="emit('update:agentId', ($event.target as HTMLInputElement).value)"
      />
    </div>

    <!-- Provider — tildá uno o varios; con 2+ el orden (arrastrando o con
         ↑/↓) es el orden de fallback que el engine evalúa. -->
    <div class="field">
      <span class="label">Provider <span class="req">*</span></span>
      <span class="field-hint">
        Tildá al menos uno. Con más de uno, el engine ejecuta el primer candidato elegible en el
        orden de la lista (ver whenText por candidato).
      </span>
      <ProviderChoicesEditor
        :model-value="providerChoices"
        :providers="providers"
        @update:model-value="emit('update:providerChoices', $event)"
      />
    </div>

    <!-- Per-agent provider config — form component chosen by the registry
         from `provider`. Registry falls back to JsonProviderForm for
         providers without a dedicated web form. -->
    <div class="field">
      <span class="label">Configuración del provider (por agente)</span>
      <span class="field-hint">Sobrescribe los defaults globales del provider. Vacío = usa el default global.</span>
      <component
        :is="currentProviderForm"
        :model-value="providerConfig"
        @update:model-value="emit('update:providerConfig', $event)"
      />
    </div>

    <!-- Prompt — crece para ocupar el resto del panel en vez de quedarse en
         los `rows` fijos con la página vacía debajo (ver PromptField `fill`). -->
    <div class="field field-prompt">
      <PromptField
        :model-value="prompt"
        :variables="variables"
        :rows="10"
        fill
        :variable-groups="agentVariableGroups"
        :agent-id="agentId"
        :required="true"
        template-context="agent-prompt"
        :available-system-prompts="availableSysprompts"
        :pending-proposal="pendingPromptProposal"
        hint="Ruta de archivo (./prompts/mi-prompt.md) o texto inline."
        @update:model-value="emit('update:prompt', $event)"
        @update:variables="emit('update:variables', $event)"
        @clear-pending-proposal="pendingPromptProposal = null"
      />
    </div>

  </div>
</template>

<style scoped>
.ads { display: flex; flex-direction: column; gap: 1.1rem; flex: 1; min-height: 0; }

.field { display: flex; flex-direction: column; gap: 0.3rem; }
.field-prompt { flex: 1; min-height: 320px; }
.label { font-size: 0.82rem; font-weight: 600; color: var(--fg-mute); }
.req { color: var(--danger); }
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

.ai-form-bar { display: flex; justify-content: flex-end; }
.btn-ai-form {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.25rem 0.7rem;
  border: 1px solid var(--border-hi);
  background: var(--panel);
  font-size: 0.78rem;
  color: var(--fg-dim);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.btn-ai-form:hover { border-color: var(--magenta); color: var(--magenta); }
.btn-ai-form.active { border-color: var(--magenta); background: var(--panel-hi); color: var(--magenta); }
</style>
