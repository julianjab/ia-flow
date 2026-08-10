<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import AgentesSection from '@/features/agents/AgentesSection.vue';
import GlobalSystemPromptsSection from '@/features/project-config/GlobalSystemPromptsSection.vue';
import ProvidersSection from '@/features/providers/ProvidersSection.vue';
import EntornoSection from '@/features/env-vars/EntornoSection.vue';

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
  { id: 'entorno',        label: 'Entorno' },
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
    <EntornoSection             v-else-if="activeTab === 'entorno'" />
  </div>
</template>

<style scoped>
.gv-header { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 1rem; }
.gv-header h1 { margin: 0; font-size: 1.75rem; }
.gv-header p  { margin: 0; color: #6b7280; font-size: 0.9rem; }

.gv-tabs {
  display: flex;
  gap: 0.25rem;
  border-bottom: 1px solid #e5e7eb;
  margin-bottom: 1.25rem;
  overflow-x: auto;
}
.gv-tab {
  background: none;
  border: none;
  padding: 0.5rem 0.85rem;
  cursor: pointer;
  color: #6b7280;
  font-size: 0.9rem;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}
.gv-tab:hover { color: #111827; }
.gv-tab--active {
  color: #111827;
  border-bottom-color: #111827;
  font-weight: 600;
}
.gv-content { display: flex; flex-direction: column; gap: 1.25rem; }
</style>
