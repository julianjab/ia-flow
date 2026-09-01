<script setup lang="ts">
// "Prompt" section of the agent editor — el PromptField solo, separado de
// "Definición" (id/provider) y de "System Prompts" (adjuntos) para que el
// prompt tenga toda la altura del panel para sí, igual que antes cuando
// compartía sección con esos otros campos (ver AgentEditorModal).

import PromptField from '@/features/prompts/PromptField.vue'
import type { VariableGroup, KV } from '@/features/prompts/PromptField.vue'
import type { SystemPromptDef } from '@ia-flow/shared'

defineProps<{
  prompt: string
  variables: KV[]
  agentVariableGroups: VariableGroup[]
  agentId: string
  availableSysprompts: SystemPromptDef[]
  // Ver AgentDefinitionSection#propose-prompt — el AI-assist del form vive en
  // "Definición", así que la propuesta de prompt sube hasta AgentEditorModal
  // y baja hasta acá para mostrarse como diff.
  pendingPromptProposal: string | null
}>()

const emit = defineEmits<{
  'update:prompt': [value: string]
  'update:variables': [value: KV[]]
  'clear-pending-proposal': []
}>()
</script>

<template>
  <div class="aps">
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
      @clear-pending-proposal="emit('clear-pending-proposal')"
    />
  </div>
</template>

<style scoped>
.aps { display: flex; flex-direction: column; flex: 1; min-height: 320px; }
</style>
