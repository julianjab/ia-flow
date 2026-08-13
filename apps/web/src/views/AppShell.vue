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
  { id: 'dashboard',   label: 'Dashboard',   icon: '🏠', group: 'overview' },
  { id: 'ejecuciones', label: 'Ejecuciones', icon: '▶️', group: 'overview' },
  { id: 'general',     label: 'General',     icon: '⚙️', group: 'settings' },
  { id: 'proyectos',   label: 'Proyectos',   icon: '📁', group: 'settings' },
];

const TAB_GROUP_LABELS: Record<string, string> = {
  overview: 'Overview',
  settings: 'Settings',
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
    <SettingsSidebar
      :tabs="TABS"
      :active-tab="activeSection"
      :group-labels="TAB_GROUP_LABELS"
      :collapsed="sidebarCollapsed"
      @update:active-tab="goToSection"
      @toggle-collapsed="toggleSidebar"
    />

    <div class="app-shell__body">
      <header class="app-shell__topbar">
        <button
          type="button"
          class="app-shell__toggle"
          aria-label="Toggle menu"
          @click="toggleSidebar"
        >
          <span aria-hidden="true">☰</span>
        </button>
        <div class="app-shell__topbar-spacer" />
        <ActiveExecutionsChip />
      </header>

      <main class="app-shell__main">
        <router-view />
      </main>
    </div>

    <Toast />
  </section>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  min-height: 100vh;
}
.app-shell__topbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background: #fafafa;
  border-bottom: 1px solid #e5e7eb;
  position: sticky;
  top: 0;
  z-index: 50;
}
.app-shell__topbar-spacer { flex: 1; }
.app-shell__toggle { display: none; }
.app-shell__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.app-shell__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  padding: 1.5rem 1.75rem 3rem;
  max-width: 1080px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}

@media (max-width: 768px) {
  .app-shell {
    flex-direction: column;
    align-items: stretch;
    min-height: 100vh;
  }
  .app-shell__toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    background: #fff;
    color: #374151;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
  }
  .app-shell__toggle:hover { background: #f3f4f6; }
  .app-shell__main { padding: 1rem 1rem 3rem; }
}
</style>
