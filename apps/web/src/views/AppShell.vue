<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SettingsSidebar from '@/components/SettingsSidebar.vue';
import ActiveExecutionsChip from '@/components/ActiveExecutionsChip.vue';
import Toast from '@/ui/Toast.vue';
import { useProvidersStore } from '@/features/providers/store';
import { useProjectsStore } from '@/features/projects/store';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useGlobalConfigStore } from '@/features/project-config/globalStore';
import { useActiveExecutionsStore } from '@/features/executions/activeStore';
import { useServerEvents } from '@/composables/useServerEvents';
import { useToastStore } from '@/stores/toast';

const providersStore = useProvidersStore();
const projectsStore = useProjectsStore();
const projectConfigStore = useProjectConfigStore();
const globalConfigStore = useGlobalConfigStore();
const activeExecutionsStore = useActiveExecutionsStore();
const toastStore = useToastStore();

type SectionId = 'dashboard' | 'ejecuciones' | 'general' | 'proyectos';

const TABS: { id: SectionId; label: string; icon: string; group: string }[] = [
  { id: 'dashboard',   label: 'dashboard',   icon: '', group: 'overview' },
  { id: 'ejecuciones', label: 'ejecuciones', icon: '', group: 'overview' },
  { id: 'proyectos',   label: 'proyectos',   icon: '', group: 'flujo' },
  { id: 'general',     label: 'general',     icon: '', group: 'flujo' },
];

const TAB_GROUP_LABELS: Record<string, string> = {
  overview: 'OVERVIEW',
  flujo: 'FLUJO',
};

// Desktop: sidebar expanded by default (no hamburger-only rail).
// Mobile: collapsed by default (overlay, opened via topbar toggle).
const isMobile = () =>
  typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
const sidebarCollapsed = ref(isMobile());
function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value; }

const route = useRoute();
const router = useRouter();

// Derive the top-level section from the current path so the sidebar highlights
// correctly on any nested route (e.g. /projects/:id/board).
const activeSection = computed<SectionId>(() => {
  const path = route.path;
  if (path === '/' || path === '') return 'dashboard';
  if (path.startsWith('/projects')) return 'proyectos';
  if (path.startsWith('/general/ejecuciones')) return 'ejecuciones';
  if (path.startsWith('/general')) return 'general';
  return 'dashboard';
});

function goToSection(id: SectionId) {
  if (id === activeSection.value) return;
  if (isMobile()) sidebarCollapsed.value = true;
  if (id === 'dashboard') void router.push('/');
  else if (id === 'ejecuciones') void router.push('/general/ejecuciones');
  else if (id === 'general') void router.push('/general');
  else void router.push('/projects');
}

// Keep the global active-executions cache warm and in sync with the server.
// One WS subscription at the shell level feeds the topbar chip, dashboard,
// project cards and per-tab live indicators without each component opening
// its own listener.
useServerEvents((msg) => {
  if (msg.type === 'execution:started' || msg.type === 'execution:updated') {
    activeExecutionsStore.ingest((msg as { log: unknown }).log, msg.type);
  }
});

onMounted(async () => {
  void activeExecutionsStore.fetch();
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
      <ActiveExecutionsChip />
    </header>

    <div class="app-shell__body">
      <SettingsSidebar
        :tabs="TABS"
        :active-tab="activeSection"
        :group-labels="TAB_GROUP_LABELS"
        :collapsed="sidebarCollapsed"
        @update:active-tab="goToSection"
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
