<script setup lang="ts">
import type { Project } from '@ia-flow/shared';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import ProjectCreateModal from '@/features/projects/ProjectCreateModal.vue';
import { useProjectsStore } from '@/features/projects/store';

const projectsStore = useProjectsStore();
const router = useRouter();

const createOpen = ref(false);

function openProject(id: string) {
  void router.push(`/projects/${id}/overview`);
}

// Derived on the client for now — server resolves the same way in
// getSourceForProject(). Once we support more provider kinds (linear,
// jira, …) this becomes an explicit `project.provider` field.
function providerKind(p: Project): 'github' | 'local' {
  return p.githubProjectUrl ? 'github' : 'local';
}

const PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub',
  local: 'Local',
};
</script>

<template>
  <header class="pl-header">
    <div>
      <h1>Proyectos</h1>
      <p>Cada proyecto agrupa sus statuses y (opcionalmente) sus propios agentes.</p>
    </div>
    <button class="pl-add-btn" data-testid="new-project" @click="createOpen = true">
      + Nuevo proyecto
    </button>
  </header>

  <div v-if="projectsStore.loading" class="pl-empty">Cargando…</div>
  <div v-else-if="!projectsStore.projects.length" class="pl-empty">
    Aún no hay proyectos. Crea el primero.
  </div>
  <div v-else class="pl-grid">
    <button
      v-for="p in projectsStore.projects"
      :key="p.id"
      class="pl-card"
      :data-testid="`project-card-${p.id}`"
      @click="openProject(p.id)"
    >
      <div class="pl-card__title-row">
        <span class="pl-card__title">{{ p.name }}</span>
        <code class="pl-card__id">{{ p.id }}</code>
      </div>
      <div class="pl-card__meta">
        <span :class="['pl-provider', `pl-provider--${providerKind(p)}`]">
          {{ PROVIDER_LABEL[providerKind(p)] }}
        </span>
      </div>
    </button>
  </div>

  <ProjectCreateModal
    :open="createOpen"
    @close="createOpen = false"
    @created="(id) => openProject(id)"
  />
</template>

<style scoped>
.pl-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
}
.pl-header h1 { margin: 0 0 0.25rem; font-size: 1.75rem; }
.pl-header p  { margin: 0; color: #6b7280; font-size: 0.9rem; }
.pl-add-btn {
  padding: 0.55rem 1rem;
  background: #111827;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
  cursor: pointer;
}
.pl-empty {
  padding: 2rem;
  color: #6b7280;
  background: #f9fafb;
  border-radius: 8px;
  text-align: center;
}
.pl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}
.pl-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  text-align: left;
  cursor: pointer;
  transition: box-shadow 120ms ease, transform 120ms ease;
}
.pl-card:hover {
  box-shadow: 0 4px 12px rgba(0,0,0,0.06);
  transform: translateY(-1px);
}
.pl-card__title-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.pl-card__title { font-weight: 600; font-size: 1rem; flex: 1; min-width: 0; }
.pl-card__id {
  background: #f3f4f6;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-size: 0.75rem;
  color: #374151;
}
.pl-card__meta { color: #6b7280; font-size: 0.8rem; }
.pl-provider {
  display: inline-flex;
  align-items: center;
  padding: 0.1rem 0.5rem;
  border-radius: 4px;
  font-size: 0.7rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.pl-provider--github { background: #eef2ff; color: #4338ca; }
.pl-provider--local  { background: #f3f4f6; color: #4b5563; }
</style>
