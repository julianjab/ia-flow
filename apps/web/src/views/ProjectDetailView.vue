<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useProjectsStore } from '@/features/projects/store';
import AgentesSection from '@/features/agents/AgentesSection.vue';
import NamedActionsSection from '@/features/rules/NamedActionsSection.vue';
import RulesSection from '@/features/rules/RulesSection.vue';
import ToolsSection from '@/features/tools/ToolsSection.vue';
import ExecutionsSection from '@/features/executions/ExecutionsSection.vue';
import StatusesSection from '@/features/statuses/StatusesSection.vue';
import NextUpSection from '@/features/tasks/NextUpSection.vue';
import TareasSection from '@/features/tasks/TareasSection.vue';
import ProjectOverviewTab from '@/features/projects/tabs/ProjectOverviewTab.vue';
import ProjectProviderTab from '@/features/projects/tabs/ProjectProviderTab.vue';
import ProjectReposTab from '@/features/projects/tabs/ProjectReposTab.vue';
import ProjectSystemPromptsTab from '@/features/projects/tabs/ProjectSystemPromptsTab.vue';

/**
 * El detalle de un proyecto: resuelve el `tab` de la URL a su sección y nada
 * más.
 *
 * Tenía además un `.pd-header` con el nombre del proyecto, su id, la URL del
 * source y el toggle de polling. Se borró entero (R9, R12): el nombre ya lo
 * dice la barra de identidad del shell —repetirlo era el mismo dato dos veces
 * y 200px de chrome en un teléfono—, el id y la URL viven en `overview`, que
 * es donde se van a buscar, y el toggle de polling se mudó al sheet de `⋯`
 * como `ProjectPollingToggle`, con su estado y su suscripción al WS adentro.
 * Lo que queda es composición, que es lo único que una `view` debería tener.
 */
const props = defineProps<{ id: string; tab: string }>();

const projectsStore = useProjectsStore();

// La sub-navegación del proyecto vive en el sidebar (desktop) y en la tab bar
// (mobile). Acá sólo se resuelve el `tab` de la URL.
const VALID_TABS = new Set([
  'overview', 'que-sigue', 'executions', 'tareas', 'board',
  'agentes', 'pipeline', 'acciones', 'tools', 'system-prompts', 'repos', 'provider',
]);
const activeTab = computed(() => (VALID_TABS.has(props.tab) ? props.tab : 'overview'));

const project = computed(() =>
  projectsStore.projects.find((p) => p.id === props.id) ?? null,
);

// Apunta el store de config compartido al proyecto de la URL. AppShell tiene
// un watcher que re-fetchea cuando cambia `activeProjectId`.
function syncActiveProject() {
  if (projectsStore.activeProjectId !== props.id) {
    projectsStore.setActiveProjectId(props.id);
  }
}

onMounted(syncActiveProject);
watch(() => props.id, syncActiveProject);

// Si la lista de proyectos llega después del mount, hay que sincronizar otra vez.
watch(
  () => projectsStore.projects.length,
  () => syncActiveProject(),
);
</script>

<template>
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
    <ToolsSection
      v-else-if="activeTab === 'tools' && project"
      :scope="{ kind: 'project', projectId: project.id }"
    />
    <StatusesSection          v-else-if="activeTab === 'board'" />
    <ProjectSystemPromptsTab  v-else-if="activeTab === 'system-prompts'" />
    <ProjectReposTab          v-else-if="activeTab === 'repos'" />
    <NextUpSection            v-else-if="activeTab === 'que-sigue'" />
    <TareasSection            v-else-if="activeTab === 'tareas'" />
    <ProjectProviderTab       v-else-if="activeTab === 'provider'" :project="project" />
    <ExecutionsSection        v-else-if="activeTab === 'executions'" />
  </div>
</template>

<style scoped>
.pd-content { display: flex; flex-direction: column; gap: 1.25rem; }
</style>
