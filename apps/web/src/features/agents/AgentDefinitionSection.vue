<script setup lang="ts">
// La franja "Qué es" del editor de agentes (R19): lo que IDENTIFICA al agente,
// y nada más. Hoy eso es un solo campo — el id.
//
// El provider vivía acá y se fue a `AgentRunSection`: elegir el modelo es
// "cómo corre", no "qué es". Que estuviera en Definición es lo que hacía que
// la primera pantalla del editor mezclara el nombre del agente con su
// presupuesto de tokens.
//
// La barra de AI-assist se queda: no pertenece a una franja sino al
// FORMULARIO — prellena campos de tres secciones distintas (System Prompts,
// Prompt, Herramientas) y los reenvía hacia arriba con sus propios
// `update:*` / `apply-tools` / `propose-prompt`. Va al tope del formulario,
// que es esta franja.

import { computed, ref } from 'vue'
import AiAssistPanel from '@/features/agents/AiAssistPanel.vue'
import type { VariableGroup, KV } from '@/features/prompts/PromptField.vue'
import type { AgentProviderChoice, SystemPromptDef } from '@ia-flow/shared'

interface ToolDef { name: string; description: string }

const props = defineProps<{
  agentId: string
  isNew: boolean
  /** Sólo para nombrarle al modelo con qué provider se está editando. Elegirlo
   *  es de `AgentRunSection`; acá no se toca. */
  providerChoices: AgentProviderChoice[]
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
  'update:providerConfig': [value: Record<string, unknown>]
  'update:prompt': [value: string]
  // El prompt vive en su propia sección ahora — cuando el AI-assist propone
  // uno distinto al existente, no lo pisa: sube la propuesta para que
  // AgentEditorModal se la pase a AgentPromptSection, que la muestra como
  // diff (mismo flujo que `refine`, ver PromptField).
  'propose-prompt': [value: string]
  'update:variables': [value: KV[]]
  'update:selectedSysprompts': [value: string[]]
  'apply-tools': [names: string[]]
}>()

const primaryProviderId = computed(() => props.providerChoices[0]?.providerId ?? '')

// ─── Form-level AI assist (form-fill mode) ────────────────────────────────
const aiOpen = ref(false)

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
      emit('propose-prompt', fields.prompt)
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

    <!-- ID. El placeholder lleva la FORMA esperada y el hint la consecuencia
         que no se adivina — que otras cosas lo referencian, así que cambiarlo
         después las rompe (R21). -->
    <div class="ff-row">
      <span class="uc-label">Id <span class="req">*</span></span>
      <input
        :value="agentId"
        class="ff-field ff-mono"
        placeholder="functional-refiner"
        :disabled="!isNew"
        @input="emit('update:agentId', ($event.target as HTMLInputElement).value)"
      />
      <p class="ff-hint">
        {{ isNew
          ? 'Sin espacios. Las reglas del pipeline lo nombran por acá.'
          : 'No se cambia después de crear: las reglas del pipeline lo nombran por acá.' }}
      </p>
    </div>

  </div>
</template>

<style scoped src="@/ui/form-fields.css"></style>

<style scoped>
.ads { display: flex; flex-direction: column; gap: 0.9rem; }
.req { color: var(--danger); }

.ai-form-bar { display: flex; justify-content: flex-end; }
/* `--ai` y el glifo son de salida de modelo, y de nada más (R16). */
.btn-ai-form {
  display: inline-flex;
  align-items: center;
  gap: 0.4ch;
  min-height: var(--tap-h-sm);
  padding: 0 0.9ch;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel-alt);
  font-size: var(--fs-body-sm);
  color: var(--fg-dim);
  cursor: pointer;
}
.btn-ai-form:hover { border-color: var(--ai); color: var(--ai); }
.btn-ai-form.active { border-color: var(--ai); background: var(--panel-hi); color: var(--ai); }
</style>
