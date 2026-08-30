<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AgentesSection from '@/features/agents/AgentesSection.vue';
import RulesSection from '@/features/rules/RulesSection.vue';
import ToolsSection from '@/features/tools/ToolsSection.vue';
import ExecutionsSection from '@/features/executions/ExecutionsSection.vue';
import GlobalSystemPromptsSection from '@/features/project-config/GlobalSystemPromptsSection.vue';
import ProvidersSection from '@/features/providers/ProvidersSection.vue';
import McpCatalogSection from '@/features/mcp-catalog/McpCatalogSection.vue';
import EntornoSection from '@/features/env-vars/EntornoSection.vue';
import ScanRootsSection from '@/features/repos/ScanRootsSection.vue';
import ServerLogsSection from '@/features/server-logs/ServerLogsSection.vue';

// Cada tab que antes vivía bajo /general ahora es una sección top-level en
// el sidebar. Esta vista es solo el switch entre secciones y su título
// depende del tab activo (ya no hay wrapper "General").
const props = defineProps<{ tab: string }>();

interface SectionMeta { label: string; hint: string; scope: 'global' | 'server' }
const SECTIONS: Record<string, SectionMeta> = {
  agentes:          { label: 'Agentes',        hint: 'Qué hace cada agente. Cuándo corre lo decide una regla.',           scope: 'global' },
  pipeline:         { label: 'Pipeline',       hint: 'Qué evento dispara qué, y qué está corriendo ahora. Éstas ven todos los proyectos.', scope: 'global' },
  'system-prompts': { label: 'System Prompts', hint: 'Prompts base que los agentes reciben antes de la tarea.',          scope: 'global' },
  providers:        { label: 'Providers',      hint: 'Configuración por defecto de cada backend de LLM.',                scope: 'global' },
  tools:            { label: 'Tools',          hint: 'Lo que un agente puede invocar. Las definidas ejecutan una acción; de las built-in se ajusta la descripción.', scope: 'global' },
  'mcp-catalog':    { label: 'MCP Catalog',    hint: 'Servidores MCP disponibles para que un agente los reclame.',       scope: 'global' },
  entorno:          { label: 'Entorno',        hint: 'Variables inyectadas a los procesos del daemon.',                  scope: 'global' },
  escaneo:          { label: 'Escaneo',        hint: 'Roots del filesystem que el daemon indexa.',                       scope: 'global' },
  ejecuciones:      { label: 'Ejecuciones',    hint: 'Registro global de runs — filtra por proyecto, agente u outcome.', scope: 'server' },
  logs:             { label: 'Logs',           hint: 'Salida NDJSON de Pino del daemon.',                                 scope: 'server' },
};

const activeTab = computed(() => (SECTIONS[props.tab] ? props.tab : 'agentes'));
const meta = computed(() => SECTIONS[activeTab.value]);

// Al entrar al detalle de un agente, ese editor pasa a ser la página — el
// header "Agentes / Biblioteca de..." de este switcher no aplica ahí (ya lo
// dice el propio editor en su topbar). Ver AgentesSection.resolveAgentFromRoute.
const route = useRoute();
const showHeader = computed(() => !(activeTab.value === 'agentes' && route.params.agentId));
</script>

<template>
  <header v-if="showHeader" class="gv-header">
    <h1>{{ meta.label }}</h1>
    <p>{{ meta.hint }}</p>
  </header>


  <div class="gv-content">
    <AgentesSection             v-if="activeTab === 'agentes'" scope="global" />
    <RulesSection               v-else-if="activeTab === 'pipeline'" :scope="{ kind: 'global' }" />
    <GlobalSystemPromptsSection v-else-if="activeTab === 'system-prompts'" />
    <ProvidersSection           v-else-if="activeTab === 'providers'" />
    <ToolsSection               v-else-if="activeTab === 'tools'" />
    <McpCatalogSection          v-else-if="activeTab === 'mcp-catalog'" />
    <EntornoSection             v-else-if="activeTab === 'entorno'" />
    <ScanRootsSection           v-else-if="activeTab === 'escaneo'" />
    <ExecutionsSection          v-else-if="activeTab === 'ejecuciones'" scope="global" />
    <ServerLogsSection          v-else-if="activeTab === 'logs'" />
  </div>
</template>

<style scoped>
.gv-header { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 0.75rem; }
.gv-header h1 {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: var(--tracking-hd);
  text-transform: uppercase;
  color: var(--fg);
}
.gv-header p {
  margin: 0;
  color: var(--fg-mute);
  font-size: var(--fs-body-sm);
}

.gv-content { display: flex; flex-direction: column; gap: 1rem; }
</style>
