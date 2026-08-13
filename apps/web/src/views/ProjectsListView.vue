<script setup lang="ts">
import type { ExecutionLog, Project } from '@ia-flow/shared';
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import ProjectCreateModal from '@/features/projects/ProjectCreateModal.vue';
import { useProjectsStore } from '@/features/projects/store';
import { useActiveExecutionsStore } from '@/features/executions/activeStore';
import { fetchExecutions } from '@/features/executions/api';
import { fetchPollingStatus, type PollingStatus } from '@/features/projects/api';
import { formatRelative } from '@/features/executions/relativeTime';

const projectsStore = useProjectsStore();
const activeExecutionsStore = useActiveExecutionsStore();
const router = useRouter();

const createOpen = ref(false);

const lastByProject = ref<Record<string, ExecutionLog | undefined>>({});
const pollingByProject = ref<Record<string, PollingStatus | null>>({});

onMounted(async () => {
  if (!activeExecutionsStore.loaded) void activeExecutionsStore.fetch();
  try {
    const recent = await fetchExecutions({ limit: 200 });
    const map: Record<string, ExecutionLog | undefined> = {};
    for (const e of recent) if (!map[e.projectId]) map[e.projectId] = e;
    lastByProject.value = map;
  } catch { /* dashboard-only enrichment; ignore failures */ }

  const results = await Promise.all(
    projectsStore.projects.map(async (p) => {
      try { return [p.id, await fetchPollingStatus(p.id)] as const; }
      catch { return [p.id, null] as const; }
    }),
  );
  const map: Record<string, PollingStatus | null> = {};
  for (const [id, s] of results) map[id] = s;
  pollingByProject.value = map;
});

function outcomeColor(o: ExecutionLog['outcome']): string {
  switch (o) {
    case 'success':   return '#16a34a';
    case 'error':     return '#dc2626';
    case 'cancelled': return '#6b7280';
    case 'truncated': return '#ea580c';
    default:          return '#9ca3af';
  }
}
function outcomeSymbol(o: ExecutionLog['outcome']): string {
  switch (o) {
    case 'success':   return '✓';
    case 'error':     return '✕';
    case 'cancelled': return '⊘';
    case 'truncated': return '…';
    default:          return '•';
  }
}
function pollingClass(p: Project): string {
  const s = pollingByProject.value[p.id];
  if (s === undefined || s === null) return 'pl-dot pl-dot--gray';
  return s.paused ? 'pl-dot pl-dot--red' : 'pl-dot pl-dot--green';
}
function pollingTitle(p: Project): string {
  const s = pollingByProject.value[p.id];
  if (s === undefined || s === null) return 'Polling sin configurar';
  return s.paused ? 'Polling pausado' : 'Polling activo';
}

function openProject(id: string) {
  void router.push(`/projects/${id}/overview`);
}

// The source kind is authoritative on the project row (matches the same
// dispatch the server uses in getSourceForProject).
function providerKind(p: Project): string {
  return p.source?.kind ?? 'local'
}

// Labels for known kinds; unknown kinds fall through to the raw string so
// a new source registered server-side is at least identifiable.
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
        <span :class="pollingClass(p)" :title="pollingTitle(p)" />
        <span class="pl-card__title">{{ p.name }}</span>
        <code class="pl-card__id">{{ p.id }}</code>
      </div>
      <div class="pl-card__meta">
        <span :class="['pl-provider', `pl-provider--${providerKind(p)}`]">
          {{ PROVIDER_LABEL[providerKind(p)] }}
        </span>
        <span
          v-if="activeExecutionsStore.countForProject(p.id) > 0"
          class="pl-live-badge"
          title="Ejecuciones activas"
        >
          {{ activeExecutionsStore.countForProject(p.id) }} corriendo
        </span>
        <span v-if="lastByProject[p.id]" class="pl-last">
          hace {{ formatRelative(lastByProject[p.id]!.startedAt).replace(/^hace /, '') }} ·
          <span :style="{ color: outcomeColor(lastByProject[p.id]!.outcome) }">
            {{ outcomeSymbol(lastByProject[p.id]!.outcome) }}
          </span>
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
.pl-card__meta { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.pl-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.pl-dot--green { background: #22c55e; box-shadow: 0 0 0 2px rgba(34,197,94,0.2); }
.pl-dot--red   { background: #ef4444; box-shadow: 0 0 0 2px rgba(239,68,68,0.2); }
.pl-dot--gray  { background: #9ca3af; box-shadow: 0 0 0 2px rgba(156,163,175,0.2); }
.pl-live-badge {
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: #dcfce7;
  color: #166534;
  font-size: 0.7rem;
  font-weight: 600;
}
.pl-last { color: #6b7280; font-size: 0.75rem; }
</style>
