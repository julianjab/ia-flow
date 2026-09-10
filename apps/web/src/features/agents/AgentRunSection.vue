<script setup lang="ts">
// La franja "Cómo corre" del editor de agentes (R19): con qué provider, con
// qué modelo, con qué tools y con qué servidores MCP. Todo lo de acá tiene un
// default que ya funciona — es por eso que puede ir plegada bajo 1100px sin
// romper la condición 2 del test para plegar.
//
// Provider y su config por agente venían de `AgentDefinitionSection`. El
// movimiento no es cosmético: mientras vivían en "Definición", la primera
// pantalla del editor mezclaba el nombre del agente con su presupuesto de
// tokens, y el resumen de esa sección tenía que hablar de dos cosas a la vez.

import { computed } from 'vue'
import ProviderChoicesEditor from '@/features/agents/ProviderChoicesEditor.vue'
import ToolsEditor from '@/features/agents/ToolsEditor.vue'
import { providerFormFor } from '@/features/agents/providerForms/registry'
import type { AgentToolEntry, McpCatalogEntry } from '@ia-flow/shared'
import type { AgentProviderChoice } from '@ia-flow/shared'

interface ProviderOption { id: string; name?: string }

const props = defineProps<{
  /** Siempre un array — 1 candidato es el caso común, 2+ agrega orden de
   *  fallback (ver AgentProviderSchema). AgentEditorModal decide si lo que se
   *  guarda es un string plano o el array completo. */
  providerChoices: AgentProviderChoice[]
  providers: ProviderOption[]
  providerConfig: Record<string, unknown>
  tools: AgentToolEntry[] | undefined
  mcpCatalog: McpCatalogEntry[]
  selectedMcpCatalogIds: string[]
}>()

const emit = defineEmits<{
  'update:providerChoices': [value: AgentProviderChoice[]]
  'update:providerConfig': [value: Record<string, unknown>]
  'update:tools': [value: AgentToolEntry[] | undefined]
  'update:selectedMcpCatalogIds': [value: string[]]
}>()

const primaryProviderId = computed(() => props.providerChoices[0]?.providerId ?? '')
// El registry cae a JsonProviderForm para un provider sin formulario propio.
const currentProviderForm = computed(() => providerFormFor(primaryProviderId.value))

function toggleMcpCatalog(id: string) {
  const next = props.selectedMcpCatalogIds.includes(id)
    ? props.selectedMcpCatalogIds.filter((x) => x !== id)
    : [...props.selectedMcpCatalogIds, id]
  emit('update:selectedMcpCatalogIds', next)
}
</script>

<template>
  <div class="ars">

    <!-- Provider — tildá uno o varios; con 2+ el orden (arrastrando o con
         ↑/↓) es el orden de fallback que el engine evalúa. -->
    <div class="ff-row">
      <span class="uc-label">Provider <span class="req">*</span></span>
      <ProviderChoicesEditor
        :model-value="providerChoices"
        :providers="providers"
        @update:model-value="emit('update:providerChoices', $event)"
      />
      <p class="ff-hint">
        Con más de uno, corre el primer candidato elegible en el orden de la lista.
      </p>
    </div>

    <div class="ff-row">
      <span class="uc-label">Config del provider</span>
      <component
        :is="currentProviderForm"
        :key="primaryProviderId"
        :model-value="providerConfig"
        @update:model-value="emit('update:providerConfig', $event)"
      />
      <p class="ff-hint">Vacío usa el default global de ese provider.</p>
    </div>

    <div class="ff-row">
      <span class="uc-label">Tools</span>
      <ToolsEditor :tools="tools" @update:tools="emit('update:tools', $event)" />
      <p class="ff-hint">Sin ninguna tildada, el agente corre sin tools.</p>
    </div>

    <div class="ff-row">
      <span class="uc-label">MCP servers</span>
      <div v-if="mcpCatalog.length" class="ff-chips">
        <label
          v-for="entry in mcpCatalog"
          :key="entry.id"
          class="ff-chip"
          :class="{ 'ff-chip--on': selectedMcpCatalogIds.includes(entry.id) }"
          :title="entry.description ?? entry.name"
          @click="toggleMcpCatalog(entry.id)"
        >
          <span class="ff-chip-check">{{ selectedMcpCatalogIds.includes(entry.id) ? '✓' : '' }}</span>
          <span class="ff-chip-mono">{{ entry.id }}</span>
          <span class="ff-chip-note">{{ entry.name }}</span>
        </label>
      </div>
      <p class="ff-hint">
        <template v-if="mcpCatalog.length">
          Un override inline en <code>providerConfig.mcpServers</code> le gana a esta selección.
        </template>
        <template v-else>Sin entradas — creá una en General → MCP Catalog.</template>
      </p>
    </div>

  </div>
</template>

<style scoped src="@/ui/form-fields.css"></style>

<style scoped>
.ars { display: flex; flex-direction: column; gap: 0.9rem; }
.req { color: var(--danger); }
</style>
