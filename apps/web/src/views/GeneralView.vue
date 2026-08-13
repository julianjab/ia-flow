<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import AgentesSection from '@/features/agents/AgentesSection.vue';
import ExecutionsSection from '@/features/executions/ExecutionsSection.vue';
import GlobalSystemPromptsSection from '@/features/project-config/GlobalSystemPromptsSection.vue';
import ProvidersSection from '@/features/providers/ProvidersSection.vue';
import McpCatalogSection from '@/features/mcp-catalog/McpCatalogSection.vue';
import EntornoSection from '@/features/env-vars/EntornoSection.vue';
import ScanRootsSection from '@/features/repos/ScanRootsSection.vue';
import ServerLogsSection from '@/features/server-logs/ServerLogsSection.vue';

const props = defineProps<{ tab: string }>();
const router = useRouter();

interface Tab {
  id: string;
  label: string;
}

const TABS: Tab[] = [
  { id: 'agentes',        label: 'Agentes' },
  { id: 'system-prompts', label: 'System Prompts' },
  { id: 'providers',      label: 'Providers' },
  { id: 'mcp-catalog',    label: 'MCP Catalog' },
  { id: 'entorno',        label: 'Entorno' },
  { id: 'escaneo',        label: 'Escaneo' },
  { id: 'ejecuciones',    label: 'Ejecuciones' },
  { id: 'logs',           label: 'Logs' },
];

const activeTab = computed(() => (TABS.some((t) => t.id === props.tab) ? props.tab : 'agentes'));

function switchTab(tabId: string) {
  if (tabId === activeTab.value) return;
  void router.push(`/general/${tabId}`);
}
</script>

<template>
  <header class="gv-header">
    <h1>General</h1>
    <p>Configuración que aplica a todos los proyectos.</p>
  </header>

  <nav class="gv-tabs" role="tablist">
    <button
      v-for="t in TABS"
      :key="t.id"
      :class="['gv-tab', { 'gv-tab--active': t.id === activeTab }]"
      :data-testid="`general-tab-${t.id}`"
      role="tab"
      :aria-selected="t.id === activeTab"
      @click="switchTab(t.id)"
    >
      {{ t.label }}
    </button>
  </nav>

  <div class="gv-content">
    <AgentesSection             v-if="activeTab === 'agentes'" scope="global" />
    <GlobalSystemPromptsSection v-else-if="activeTab === 'system-prompts'" />
    <ProvidersSection           v-else-if="activeTab === 'providers'" />
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

.gv-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border);
  background: var(--panel-hi);
  margin-bottom: 1rem;
  overflow-x: auto;
}
.gv-tab {
  background: transparent;
  border: none;
  padding: 0.4rem 1rem;
  cursor: pointer;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  border-right: 1px solid var(--border);
  white-space: nowrap;
}
.gv-tab:hover { color: var(--fg); background: var(--panel-alt); }
.gv-tab--active {
  color: var(--panel);
  background: var(--accent);
  font-weight: 500;
}
.gv-tab--active:hover { background: var(--accent); color: var(--panel); }
.gv-content { display: flex; flex-direction: column; gap: 1rem; }
</style>
