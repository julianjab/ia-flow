<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import SettingsSidebar from '@/components/SettingsSidebar.vue';
import Toast from '@/ui/Toast.vue';
import { useProvidersStore } from '@/features/providers/store';
import { useProjectsStore } from '@/features/projects/store';
import { usePromptsStore } from '@/features/prompts/store';
import { useProjectConfigStore } from '@/features/project-config/store';
import { useGlobalConfigStore } from '@/features/project-config/globalStore';
import { useToastStore } from '@/stores/toast';

const providersStore = useProvidersStore();
const projectsStore = useProjectsStore();
const promptsStore = usePromptsStore();
const projectConfigStore = useProjectConfigStore();
const globalConfigStore = useGlobalConfigStore();
const toastStore = useToastStore();

type SectionId = 'general' | 'proyectos' | 'repos';

const TABS: { id: SectionId; label: string; icon: string; group: string }[] = [
  { id: 'general',   label: 'General',   icon: '⚙️', group: 'settings' },
  { id: 'proyectos', label: 'Proyectos', icon: '📁', group: 'settings' },
  { id: 'repos',     label: 'Repos',     icon: '📦', group: 'settings' },
];

const TAB_GROUP_LABELS: Record<string, string> = { settings: 'Settings' };

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
  if (path.startsWith('/projects')) return 'proyectos';
  if (path.startsWith('/repos')) return 'repos';
  return 'general';
});

function goToSection(id: SectionId) {
  if (id === activeSection.value) return;
  if (isMobile()) sidebarCollapsed.value = true;
  if (id === 'general') void router.push('/general');
  else if (id === 'proyectos') void router.push('/projects');
  else void router.push('/repos');
}

onMounted(async () => {
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
    await promptsStore.fetch();
  } catch (e) {
    toastStore.error(`Failed to load phase prompts: ${e instanceof Error ? e.message : String(e)}`);
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
    <header class="app-shell__topbar">
      <button
        type="button"
        class="app-shell__toggle"
        aria-label="Toggle menu"
        @click="toggleSidebar"
      >
        <span aria-hidden="true">☰</span>
      </button>
    </header>

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
.app-shell__topbar { display: none; }
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
  .app-shell__topbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    position: sticky;
    top: 0;
    z-index: 50;
    background: #fafafa;
    border-bottom: 1px solid #e5e7eb;
    padding: 0.5rem 0.75rem;
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
