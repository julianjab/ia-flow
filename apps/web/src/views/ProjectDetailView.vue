<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useProjectsStore } from '@/features/projects/store';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useActiveExecutionsStore } from '@/features/executions/activeStore';
import { useServerEvents } from '@/composables/useServerEvents';
import { useToastStore } from '@/stores/toast';
import {
  fetchPollingStatus,
  pausePolling,
  resumePolling,
} from '@/features/projects/api';
import AgentesSection from '@/features/agents/AgentesSection.vue';
import ExecutionsSection from '@/features/executions/ExecutionsSection.vue';
import StatusesSection from '@/features/statuses/StatusesSection.vue';
import TareasSection from '@/features/tasks/TareasSection.vue';
import ProjectOverviewTab from '@/features/projects/tabs/ProjectOverviewTab.vue';
import ProjectProviderTab from '@/features/projects/tabs/ProjectProviderTab.vue';
import ProjectReposTab from '@/features/projects/tabs/ProjectReposTab.vue';
import ProjectSystemPromptsTab from '@/features/projects/tabs/ProjectSystemPromptsTab.vue';

const props = defineProps<{ id: string; tab: string }>();

const projectsStore = useProjectsStore();
const projectConfigStore = useProjectConfigStore();
const toastStore = useToastStore();
const router = useRouter();

interface Tab {
  id: string;
  label: string;
}

const TABS: Tab[] = [
  { id: 'overview',       label: 'Overview' },
  { id: 'executions',     label: 'Ejecuciones' },
  { id: 'tareas',         label: 'Tareas' },
  { id: 'board',          label: 'Board' },
  { id: 'agentes',        label: 'Agentes' },
  { id: 'system-prompts', label: 'System Prompts' },
  { id: 'repos',          label: 'Repos' },
  { id: 'provider',       label: 'Provider' },
];

const activeExecutionsStore = useActiveExecutionsStore();
const hasActiveRun = computed(() => activeExecutionsStore.countForProject(props.id) > 0);

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

// ─── Polling pause (in-memory, per-project) ──────────────────────────────
// Header-level so it's visible from any tab. Backend flag lives in
// apps/server/src/issue-managers/polling-pause.ts and does NOT persist across
// daemon restarts (intentional: this is an operator escape hatch).
const pollingPaused = ref(false);
const pollingLoading = ref(false);
const pollingToggling = ref(false);

async function loadPollingStatus() {
  pollingLoading.value = true;
  try {
    const s = await fetchPollingStatus(props.id);
    pollingPaused.value = s.paused;
  } catch {
    // 404s while the projects list is warming up are normal — leave paused=false.
  } finally {
    pollingLoading.value = false;
  }
}

onMounted(loadPollingStatus);
watch(() => props.id, loadPollingStatus);

// Server broadcasts on any pause/resume so a second tab stays in sync.
useServerEvents((msg) => {
  if (msg.type !== 'project:polling') return;
  if (msg.projectId === props.id) pollingPaused.value = Boolean(msg.paused);
});

async function togglePolling() {
  if (pollingToggling.value) return;
  pollingToggling.value = true;
  const target = !pollingPaused.value;
  try {
    const s = target ? await pausePolling(props.id) : await resumePolling(props.id);
    pollingPaused.value = s.paused;
    toastStore.success(s.paused ? 'Polling pausado' : 'Polling reanudado');
  } catch (e) {
    toastStore.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    pollingToggling.value = false;
  }
}
</script>

<template>
  <header class="pd-header">
    <button class="pd-header__back" @click="router.push('/projects')">← Proyectos</button>
    <div class="pd-header__main">
      <div class="pd-header__left">
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
      </div>
      <button
        class="pd-polling"
        :class="{ 'pd-polling--paused': pollingPaused }"
        :disabled="pollingLoading || pollingToggling"
        :title="pollingPaused
          ? 'Polling en pausa — click para reanudar'
          : 'Polling activo — click para pausar (en memoria, no persiste al reiniciar el daemon)'"
        data-testid="project-polling-toggle"
        role="switch"
        :aria-checked="!pollingPaused"
        @click="togglePolling"
      >
        <span class="pd-polling__dot" :class="{ 'pd-polling__dot--paused': pollingPaused }" />
        <span class="pd-polling__label">
          <template v-if="pollingLoading">…</template>
          <template v-else-if="pollingToggling">{{ pollingPaused ? 'Reanudando…' : 'Pausando…' }}</template>
          <template v-else>{{ pollingPaused ? 'Polling pausado' : 'Polling activo' }}</template>
        </span>
      </button>
    </div>
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
      <span
        v-if="t.id === 'executions' && hasActiveRun"
        class="pd-tab__live-dot"
        aria-label="Ejecución en curso"
        title="Ejecución en curso"
      />
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
    <ExecutionsSection        v-else-if="activeTab === 'executions'" />
  </div>
</template>

<style scoped>
.pd-header { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
.pd-header__main {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.pd-header__left { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; flex: 1; }
.pd-polling {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  border-radius: 999px;
  border: 1px solid #d1d5db;
  background: #f0fdf4;
  color: #166534;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.pd-polling:hover:not(:disabled) { filter: brightness(0.97); }
.pd-polling:disabled { opacity: 0.6; cursor: not-allowed; }
.pd-polling--paused {
  background: #fef2f2;
  color: #991b1b;
  border-color: #fecaca;
}
.pd-polling__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 2px rgba(34,197,94,0.2);
}
.pd-polling__dot--paused {
  background: #ef4444;
  box-shadow: 0 0 0 2px rgba(239,68,68,0.2);
}
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
.pd-tab__live-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22c55e;
  margin-left: 0.4rem;
  vertical-align: middle;
  box-shadow: 0 0 0 0 rgba(34,197,94,0.6);
  animation: pd-live-pulse 1.6s ease-out infinite;
}
@keyframes pd-live-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(34,197,94,0.6); }
  70%  { box-shadow: 0 0 0 8px rgba(34,197,94,0); }
  100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
}
</style>
