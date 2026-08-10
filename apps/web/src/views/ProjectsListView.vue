<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useProjectsStore } from '@/features/projects/store';
import ProjectCreateModal from '@/features/projects/ProjectCreateModal.vue';

const projectsStore = useProjectsStore();
const router = useRouter();

const createOpen = ref(false);

function openProject(id: string) {
  void router.push(`/projects/${id}/overview`);
}
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
        <a
          v-if="p.githubProjectUrl"
          class="pl-card__gh"
          :href="p.githubProjectUrl"
          target="_blank"
          rel="noreferrer noopener"
          @click.stop
        >
          🔗 {{ p.githubProjectUrl.replace('https://github.com/', '') }} ↗
        </a>
        <span v-else class="pl-card__gh pl-card__gh--muted">Sin GitHub Project</span>
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
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}
.pl-card__title { font-weight: 600; font-size: 1rem; }
.pl-card__id {
  background: #f3f4f6;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-size: 0.75rem;
  color: #374151;
}
.pl-card__meta { color: #6b7280; font-size: 0.8rem; }
.pl-card__gh--muted { font-style: italic; }
a.pl-card__gh {
  color: #2563eb;
  text-decoration: none;
}
a.pl-card__gh:hover { text-decoration: underline; }
</style>
