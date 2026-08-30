<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { projectSourceUrl } from '@/features/projects/meta';
import { useProjectsStore } from '@/features/projects/store';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useServerEvents } from '@/composables/useServerEvents';
import { useToastStore } from '@/stores/toast';
import {
  fetchPollingStatus,
  pausePolling,
  resumePolling,
} from '@/features/projects/api';
import AgentesSection from '@/features/agents/AgentesSection.vue';
import NamedActionsSection from '@/features/rules/NamedActionsSection.vue';
import RulesSection from '@/features/rules/RulesSection.vue';
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

// Sub-nav for the project now lives in the sidebar. The view just resolves
// the URL's `tab` param to whichever section it should render.
const VALID_TABS = new Set([
  'overview', 'executions', 'tareas', 'board',
  'agentes', 'pipeline', 'acciones', 'system-prompts', 'repos', 'provider',
]);
const activeTab = computed(() => (VALID_TABS.has(props.tab) ? props.tab : 'overview'));

const project = computed(() =>
  projectsStore.projects.find((p) => p.id === props.id) ?? null,
);

const githubUrl = computed(() => projectSourceUrl(project.value?.source));

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

// ─── Polling pause (per-project) ─────────────────────────────────────────
// Header-level so it's visible from any tab. El backend persiste el flag en
// projects.settings.pollingPaused (ver apps/server/src/application/polling-pause.ts),
// así que la pausa sobrevive al reinicio del daemon.
const pollingPaused = ref(false);
// false sólo cuando el server avisa que no pudo persistir el flip.
const pollingPersisted = ref(true);
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
  if (msg.projectId !== props.id) return;
  pollingPaused.value = Boolean(msg.paused);
  pollingPersisted.value = msg.persisted !== false;
});

async function togglePolling() {
  if (pollingToggling.value) return;
  pollingToggling.value = true;
  const target = !pollingPaused.value;
  try {
    const s = target ? await pausePolling(props.id) : await resumePolling(props.id);
    pollingPaused.value = s.paused;
    pollingPersisted.value = s.persisted !== false;
    const what = s.paused ? 'Polling pausado' : 'Polling reanudado';
    if (pollingPersisted.value) toastStore.success(what);
    else toastStore.error(`${what}, pero no se pudo guardar: se pierde al reiniciar el daemon`);
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
          : pollingPersisted
            ? 'Polling activo — click para pausar (se mantiene al reiniciar el daemon)'
            : 'Polling activo — click para pausar (no se pudo guardar: se pierde al reiniciar)'"
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


  <div class="pd-content">
    <ProjectOverviewTab       v-if="activeTab === 'overview'" :project="project" />
    <AgentesSection           v-else-if="activeTab === 'agentes'" scope="project" />
    <NamedActionsSection
      v-else-if="activeTab === 'acciones' && project"
      :scope="{ kind: 'project', projectId: project.id }"
    />
    <RulesSection
      v-else-if="activeTab === 'pipeline' && project"
      :scope="{ kind: 'project', projectId: project.id }"
    />
    <StatusesSection          v-else-if="activeTab === 'board'" />
    <ProjectSystemPromptsTab  v-else-if="activeTab === 'system-prompts'" />
    <ProjectReposTab          v-else-if="activeTab === 'repos'" />
    <TareasSection            v-else-if="activeTab === 'tareas'" />
    <ProjectProviderTab       v-else-if="activeTab === 'provider'" :project="project" />
    <ExecutionsSection        v-else-if="activeTab === 'executions'" />
  </div>
</template>

<style scoped>
.pd-header { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.75rem; }
.pd-header__main {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.pd-header__left { display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; flex: 1; }

.pd-polling {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.7rem;
  height: 22px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--accent);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--fs-chrome);
  white-space: nowrap;
  flex-shrink: 0;
}
.pd-polling:hover:not(:disabled) { border-color: var(--accent); }
.pd-polling:disabled { opacity: 0.6; cursor: not-allowed; }
.pd-polling--paused { color: var(--danger); }
.pd-polling--paused:hover:not(:disabled) { border-color: var(--danger); }

.pd-polling__dot {
  width: 7px;
  height: 7px;
  background: var(--accent);
  animation: blink 1.6s ease-in-out infinite;
}
.pd-polling__dot--paused { background: var(--danger); animation: none; }

.pd-header__back {
  background: none;
  border: none;
  color: var(--fg-dim);
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--fs-chrome);
  align-self: flex-start;
  padding: 0;
}
.pd-header__back:hover { color: var(--fg); }

.pd-header__title-row { display: flex; align-items: baseline; gap: 0.75rem; }
.pd-header__title-row h1 {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: var(--tracking-hd);
  text-transform: uppercase;
  color: var(--fg);
}
.pd-header__id {
  background: var(--panel-hi);
  padding: 0.1rem 0.4rem;
  color: var(--cyan);
  font-family: var(--font-mono);
  font-size: var(--fs-chrome);
}
.pd-header__link {
  display: inline-block;
  color: var(--accent);
  text-decoration: none;
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  word-break: break-all;
}
.pd-header__link:hover { background: var(--accent); color: var(--panel); }

.pd-content { display: flex; flex-direction: column; gap: 1.25rem; }
</style>
