<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useProjectsStore } from '@/features/projects/store';
import { useProjectConfigStore } from '@/features/project-config/store';
import AgentesSection from '@/features/agents/AgentesSection.vue';
import StatusesSection from '@/features/statuses/StatusesSection.vue';
import TareasSection from '@/features/tasks/TareasSection.vue';
import ProjectOverviewTab from '@/features/projects/tabs/ProjectOverviewTab.vue';
import ProjectProviderTab from '@/features/projects/tabs/ProjectProviderTab.vue';
import ProjectReposTab from '@/features/projects/tabs/ProjectReposTab.vue';
import ProjectSystemPromptsTab from '@/features/projects/tabs/ProjectSystemPromptsTab.vue';

const props = defineProps<{ id: string; tab: string }>();

const projectsStore = useProjectsStore();
const projectConfigStore = useProjectConfigStore();
const router = useRouter();

interface Tab {
  id: string;
  label: string;
}

const TABS: Tab[] = [
  { id: 'overview',       label: 'Overview' },
  { id: 'agentes',        label: 'Agentes' },
  { id: 'board',          label: 'Board' },
  { id: 'system-prompts', label: 'System Prompts' },
  { id: 'repos',          label: 'Repos' },
  { id: 'tareas',         label: 'Tareas' },
  { id: 'provider',       label: 'Provider' },
];

const activeTab = computed(() => (TABS.some((t) => t.id === props.tab) ? props.tab : 'overview'));

const project = computed(() =>
  projectsStore.projects.find((p) => p.id === props.id) ?? null,
);

const githubUrl = computed(() => {
  const s = project.value?.source;
  if (!s || s.kind !== 'github') return null;
  const url = s.config?.url;
  return typeof url === 'string' && url ? url : null;
});

// Point the shared project-config store at the URL project. AppShell has a
// watcher that re-fetches whenever activeProjectId changes.
function syncActiveProject() {
  if (projectsStore.activeProjectId !== props.id) {
    projectsStore.setActiveProjectId(props.id);
  }
}

onMounted(syncActiveProject);
watch(() => props.id, syncActiveProject);

// If the projects list arrives after mount, we may need to sync again.
watch(
  () => projectsStore.projects.length,
  () => syncActiveProject(),
);

function switchTab(tabId: string) {
  if (tabId === activeTab.value) return;
  void router.push(`/projects/${props.id}/${tabId}`);
}
</script>

<template>
  <header class="pd-header">
    <button class="pd-header__back" @click="router.push('/projects')">← Proyectos</button>
    <div class="pd-header__title-row">
      <h1>{{ project?.name ?? props.id }}</h1>
      <code class="pd-header__id">{{ props.id }}</code>
    </div>
    <a
      v-if="githubUrl"
      class="pd-header__link"
      :href="githubUrl"
      target="_blank"
      rel="noreferrer noopener"
    >
      🔗 {{ githubUrl }} ↗
    </a>
  </header>

  <nav class="pd-tabs" role="tablist">
    <button
      v-for="t in TABS"
      :key="t.id"
      :class="['pd-tab', { 'pd-tab--active': t.id === activeTab }]"
      :data-testid="`project-tab-${t.id}`"
      @click="switchTab(t.id)"
      role="tab"
      :aria-selected="t.id === activeTab"
    >
      {{ t.label }}
    </button>
  </nav>

  <div class="pd-content">
    <ProjectOverviewTab       v-if="activeTab === 'overview'" :project="project" />
    <AgentesSection           v-else-if="activeTab === 'agentes'" scope="project" />
    <StatusesSection          v-else-if="activeTab === 'board'" />
    <ProjectSystemPromptsTab  v-else-if="activeTab === 'system-prompts'" />
    <ProjectReposTab          v-else-if="activeTab === 'repos'" />
    <TareasSection            v-else-if="activeTab === 'tareas'" />
    <ProjectProviderTab       v-else-if="activeTab === 'provider'" :project="project" />
  </div>
</template>

<style scoped>
.pd-header { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
.pd-header__back {
  background: none;
  border: none;
  color: #4b5563;
  cursor: pointer;
  font-size: 0.85rem;
  align-self: flex-start;
  padding: 0;
}
.pd-header__back:hover { color: #111827; }
.pd-header__title-row { display: flex; align-items: baseline; gap: 0.75rem; }
.pd-header__title-row h1 { margin: 0; font-size: 1.75rem; }
.pd-header__id {
  background: #f3f4f6;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.8rem;
  color: #374151;
}
.pd-header__link {
  display: inline-block;
  color: #2563eb;
  text-decoration: none;
  font-size: 0.85rem;
  word-break: break-all;
}
.pd-header__link:hover { text-decoration: underline; }
.pd-tabs {
  display: flex;
  gap: 0.25rem;
  border-bottom: 1px solid #e5e7eb;
  margin-bottom: 1.25rem;
  overflow-x: auto;
}
.pd-tab {
  background: none;
  border: none;
  padding: 0.5rem 0.85rem;
  cursor: pointer;
  color: #6b7280;
  font-size: 0.9rem;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}
.pd-tab:hover { color: #111827; }
.pd-tab--active {
  color: #111827;
  border-bottom-color: #111827;
  font-weight: 600;
}
.pd-content { display: flex; flex-direction: column; gap: 1.25rem; }
</style>
