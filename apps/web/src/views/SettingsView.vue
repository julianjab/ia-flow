<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SettingsSidebar from '../components/SettingsSidebar.vue';
import Toast from '@/ui/Toast.vue';
import ProyectoSection from '@/features/project-config/ProyectoSection.vue';
import AgentesSection from '@/features/agents/AgentesSection.vue';
import StatusesSection from '@/features/statuses/StatusesSection.vue';
import ProvidersSection from '@/features/providers/ProvidersSection.vue';
import ReposSection from '@/features/repos/ReposSection.vue';
import TareasSection from '@/features/tasks/TareasSection.vue';
import EntornoSection from '@/features/env-vars/EntornoSection.vue';
import ArchivosSection from '@/features/files/ArchivosSection.vue';
import { useProvidersStore } from '@/features/providers/store';
import { useProjectConfigStore } from '@/features/project-config/store';
import { usePromptsStore } from '@/features/prompts/store';
import { useToastStore } from '@/stores/toast';

const providersStore = useProvidersStore();
const projectConfigStore = useProjectConfigStore();
const promptsStore = usePromptsStore();
const toastStore = useToastStore();

// ─── Tabs ─────────────────────────────────────────────────────────────────
type TabId = 'proyecto' | 'agentes' | 'statuses' | 'repos' | 'providers' | 'tareas' | 'entorno' | 'archivos';
type TabGroup = 'general' | 'flujo' | 'recursos';

const TABS: { id: TabId; label: string; icon: string; group: TabGroup }[] = [
  { id: 'proyecto',  label: 'Proyecto',           icon: '🏠', group: 'general'   },
  { id: 'entorno',   label: 'Entorno',            icon: '🌱', group: 'general'   },
  { id: 'agentes',   label: 'Agentes',            icon: '🤖', group: 'flujo'     },
  { id: 'statuses',  label: 'Statuses',           icon: '🚦', group: 'flujo'     },
  { id: 'providers', label: 'Providers',          icon: '🔌', group: 'flujo'     },
  { id: 'repos',     label: 'Repos',              icon: '📦', group: 'recursos'  },
  { id: 'tareas',    label: 'Tareas',             icon: '📋', group: 'recursos'  },
  { id: 'archivos',  label: 'Archivos de config', icon: '📁', group: 'recursos'  },
];

const TAB_GROUP_LABELS: Record<TabGroup, string> = {
  general:  'General',
  flujo:    'Flujo',
  recursos: 'Recursos',
};

const TAB_IDS = TABS.map((t) => t.id) as TabId[];

const sidebarCollapsed = ref(true);
function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value; }

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

// ─── Global fetches used across multiple sections ─────────────────────────
onMounted(async () => {
  try {
    await providersStore.fetchConfig();
  } catch (e) {
    toastStore.error(`Failed to load config: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await promptsStore.fetch();
  } catch (e) {
    toastStore.error(`Failed to load phase prompts: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await projectConfigStore.fetch();
  } catch (e) {
    toastStore.error(`Failed to load project config: ${e instanceof Error ? e.message : String(e)}`);
  }
});
</script>

<template>
  <section class="settings-view">
    <SettingsSidebar
      :tabs="TABS"
      :active-tab="activeTab"
      :group-labels="TAB_GROUP_LABELS"
      :collapsed="sidebarCollapsed"
      @update:active-tab="(t) => { activeTab = t; sidebarCollapsed = true; }"
      @toggle-collapsed="toggleSidebar"
    />

    <main class="settings-main">
      <header class="settings-header">
        <div>
          <h1>ia-flow</h1>
          <p class="header-subtitle">
            Pipeline de AI para refinar e implementar tareas de ingeniería en múltiples repos.
          </p>
        </div>
      </header>

      <ProyectoSection  v-if="activeTab === 'proyecto'" />
      <AgentesSection   v-if="activeTab === 'agentes'" />
      <StatusesSection  v-if="activeTab === 'statuses'" />
      <ProvidersSection v-if="activeTab === 'providers'" />
      <ReposSection     v-if="activeTab === 'repos'" />
      <TareasSection    v-if="activeTab === 'tareas'" />
      <EntornoSection   v-if="activeTab === 'entorno'" />
      <ArchivosSection  v-if="activeTab === 'archivos'" />
    </main>

    <Toast />
  </section>
</template>

<style scoped>
.settings-view {
  display: flex;
  align-items: stretch;
  min-height: 100vh;
}
.settings-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  padding: 1.5rem 1.75rem 3rem;
  max-width: 960px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}

.settings-header h1 {
  margin: 0 0 0.25rem;
  font-size: 1.75rem;
}
.header-subtitle {
  margin: 0;
  font-size: 0.9rem;
  color: #6b7280;
}

@media (max-width: 768px) {
  .settings-view {
    flex-direction: column;
  }
  .settings-main {
    padding: 1rem 1rem 3rem;
  }
}
</style>
