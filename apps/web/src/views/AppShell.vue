<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SettingsSidebar from '@/components/SettingsSidebar.vue';
import ActiveExecutionsChip from '@/components/ActiveExecutionsChip.vue';
import RateLimitChip from '@/components/RateLimitChip.vue';
import Toast from '@/ui/Toast.vue';
import { useProvidersStore } from '@/features/providers/store';
import { useProjectsStore } from '@/features/projects/store';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useGlobalConfigStore } from '@/features/project-config/globalStore';
import { useActiveExecutionsStore } from '@/features/executions/activeStore';
import { useRateLimitStore } from '@/features/github/store';
import { useServerEvents } from '@/composables/useServerEvents';
import { useToastStore } from '@/stores/toast';

const providersStore = useProvidersStore();
const projectsStore = useProjectsStore();
const projectConfigStore = useProjectConfigStore();
const globalConfigStore = useGlobalConfigStore();
const activeExecutionsStore = useActiveExecutionsStore();
const rateLimitStore = useRateLimitStore();
const toastStore = useToastStore();

// Sidebar arquitectura de información:
//   OVERVIEW    → dashboard, ejecuciones, logs
//   PROYECTOS   → un item por proyecto (expandible con sus tabs)
//   GLOBAL      → configuración que aplica a todos los proyectos (definida a
//                 nivel top; el equivalente por-proyecto vive en las tabs del
//                 propio proyecto).
// "general" ya no existe como wrapper — sus secciones son ahora nav de
// primer nivel. Las rutas /general/<x> se mantienen para no romper deep-links
// existentes.
type SectionId =
  | 'dashboard'
  | 'ejecuciones'
  | 'logs'
  | 'proyectos'
  | 'agentes'
  | 'system-prompts'
  | 'providers'
  | 'mcp-catalog'
  | 'entorno'
  | 'escaneo';

// Tabs internos de cada proyecto — se muestran indentados bajo el proyecto
// activo en el árbol. Mismo orden que ProjectDetailView.
const PROJECT_TAB_ORDER: { id: string; label: string }[] = [
  { id: 'overview',       label: 'overview' },
  { id: 'executions',     label: 'ejecuciones' },
  { id: 'tareas',         label: 'tareas' },
  { id: 'board',          label: 'board' },
  { id: 'agentes',        label: 'agentes' },
  { id: 'system-prompts', label: 'system prompts' },
  { id: 'repos',          label: 'repos' },
  { id: 'provider',       label: 'provider' },
];

const TAB_GROUP_LABELS: Record<string, string> = {
  overview: 'OVERVIEW',
  proyectos: 'PROYECTOS',
  global: 'GLOBAL',
};

// Desktop: sidebar expanded by default (no hamburger-only rail).
// Mobile: collapsed by default (overlay, opened via topbar toggle).
const isMobile = () =>
  typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
const sidebarCollapsed = ref(isMobile());
function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value; }

const route = useRoute();
const router = useRouter();

// Cada sección de primer nivel apunta a una ruta fija. Se usa para: navegar
// al hacer clic en el padre + resaltar la sección activa según la URL actual.
const SECTION_PATH: Record<SectionId, string> = {
  dashboard:        '/',
  ejecuciones:      '/general/ejecuciones',
  logs:             '/general/logs',
  proyectos:        '/projects',
  agentes:          '/general/agentes',
  'system-prompts': '/general/system-prompts',
  providers:        '/general/providers',
  'mcp-catalog':    '/general/mcp-catalog',
  entorno:          '/general/entorno',
  escaneo:          '/general/escaneo',
};

// Deriva la sección activa a partir del path — soporta rutas anidadas
// (`/projects/:id/tab`, `/general/agentes/foo`, etc.).
const activeSection = computed<SectionId>(() => {
  const path = route.path;
  if (path === '/' || path === '') return 'dashboard';
  if (path.startsWith('/projects')) return 'proyectos';
  const matches: SectionId[] = ['ejecuciones', 'logs', 'agentes',
    'system-prompts', 'providers', 'mcp-catalog', 'entorno', 'escaneo'];
  for (const id of matches) {
    if (path === SECTION_PATH[id] || path.startsWith(`${SECTION_PATH[id]}/`)) return id;
  }
  return 'dashboard';
});

function goToSection(id: SectionId) {
  if (id === activeSection.value) return;
  if (isMobile()) sidebarCollapsed.value = true;
  void router.push(SECTION_PATH[id]);
}

function navigate(path: string) {
  if (isMobile()) sidebarCollapsed.value = true;
  void router.push(path);
}

// Cada proyecto es un hijo de "PROYECTOS"; el que está abierto expande un
// nivel más para mostrar sus tabs. Click sobre la fila del proyecto lleva a
// su overview.
const projectChildren = computed(() =>
  projectsStore.projects.map((p) => ({
    id: p.id,
    label: p.name || p.id,
    path: `/projects/${p.id}/overview`,
    children: PROJECT_TAB_ORDER.map((t) => ({
      id: `${p.id}:${t.id}`,
      label: t.label,
      path: `/projects/${p.id}/${t.id}`,
    })),
  })),
);

const TABS = computed<
  Array<{
    id: SectionId;
    label: string;
    icon: string;
    group: string;
    children?: {
      id: string;
      label: string;
      path: string;
      children?: { id: string; label: string; path: string }[];
    }[];
  }>
>(() => [
  { id: 'dashboard',        label: 'dashboard',      icon: '', group: 'overview' },
  { id: 'ejecuciones',      label: 'ejecuciones',    icon: '', group: 'overview' },
  { id: 'logs',             label: 'logs',           icon: '', group: 'overview' },

  { id: 'proyectos',        label: 'proyectos',      icon: '', group: 'proyectos', children: projectChildren.value },

  { id: 'agentes',          label: 'agentes',        icon: '', group: 'global' },
  { id: 'system-prompts',   label: 'system prompts', icon: '', group: 'global' },
  { id: 'providers',        label: 'providers',      icon: '', group: 'global' },
  { id: 'mcp-catalog',      label: 'mcp catalog',    icon: '', group: 'global' },
  { id: 'entorno',          label: 'entorno',        icon: '', group: 'global' },
  { id: 'escaneo',          label: 'escaneo',        icon: '', group: 'global' },
]);

// Keep the global active-executions cache warm and in sync with the server.
// One WS subscription at the shell level feeds the topbar chip, dashboard,
// project cards and per-tab live indicators without each component opening
// its own listener.
useServerEvents((msg) => {
  if (msg.type === 'execution:started' || msg.type === 'execution:updated') {
    activeExecutionsStore.ingest((msg as { log: unknown }).log, msg.type);
  } else if (msg.type === 'github:rate-limit') {
    rateLimitStore.ingest(msg);
  }
});

onMounted(async () => {
  void activeExecutionsStore.fetch();
  void rateLimitStore.fetch();
  // Projects list first — every scoped fetch depends on it (activeProjectId).
  try {
    await projectsStore.fetch();
  } catch (e) {
    toastStore.error(`Failed to load projects: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await providersStore.fetchConfig();
  } catch (e) {
    toastStore.error(`Failed to load config: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await globalConfigStore.fetch();
  } catch (e) {
    toastStore.error(`Failed to load globals: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await projectConfigStore.fetch();
  } catch (e) {
    toastStore.error(`Failed to load project config: ${e instanceof Error ? e.message : String(e)}`);
  }
});

// Reload project-scoped config whenever the active project changes.
watch(
  () => projectsStore.activeProjectId,
  async (next, prev) => {
    if (!next || next === prev) return;
    try {
      await projectConfigStore.fetch();
    } catch (e) {
      toastStore.error(`Failed to load project config: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);
</script>

<template>
  <section class="app-shell">
    <!-- Window chrome — mac-lights on the left, breadcrumb centre, chip right. -->
    <header class="app-shell__chrome">
      <div class="app-shell__lights" aria-hidden="true">
        <span class="app-shell__light app-shell__light--r" />
        <span class="app-shell__light app-shell__light--y" />
        <span class="app-shell__light app-shell__light--g" />
      </div>
      <button
        type="button"
        class="app-shell__toggle"
        aria-label="Toggle menu"
        @click="toggleSidebar"
      >☰</button>
      <span class="app-shell__title">ia-flow — {{ activeSection }}</span>
      <RateLimitChip />
      <ActiveExecutionsChip />
    </header>

    <div class="app-shell__body">
      <SettingsSidebar
        :tabs="TABS"
        :active-tab="activeSection"
        :active-path="route.path"
        :group-labels="TAB_GROUP_LABELS"
        :collapsed="sidebarCollapsed"
        @update:active-tab="goToSection"
        @navigate="navigate"
        @toggle-collapsed="toggleSidebar"
      />

      <main class="app-shell__main">
        <router-view />
      </main>
    </div>

    <Toast />
  </section>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-mono);
}

.app-shell__chrome {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0.75rem;
  background: var(--panel-hi);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 50;
  height: 32px;
  box-sizing: border-box;
}
.app-shell__lights { display: flex; gap: 0.35rem; }
.app-shell__light { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
.app-shell__light--r { background: #ff5f57; }
.app-shell__light--y { background: #febc2e; }
.app-shell__light--g { background: #28c840; }
.app-shell__toggle {
  display: none;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--fg-dim);
  cursor: pointer;
  padding: 0 0.5rem;
  height: 20px;
  font: 500 var(--fs-chrome)/1 var(--font-mono);
}
.app-shell__title {
  flex: 1;
  text-align: center;
  font-size: var(--fs-chrome);
  color: var(--fg-dim);
  letter-spacing: 0.06em;
}

.app-shell__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: row;
  align-items: stretch;
}
.app-shell__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding: 1.25rem 1.5rem 2.5rem;
  max-width: 1560px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}

@media (max-width: 768px) {
  .app-shell__toggle { display: inline-flex; align-items: center; justify-content: center; }
  .app-shell__title { display: none; }
  .app-shell__main { padding: 0.75rem 0.75rem 2rem; }
}
</style>
