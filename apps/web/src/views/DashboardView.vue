<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { fetchExecutions } from '@/features/executions/api';
import { useActiveExecutionsStore } from '@/features/executions/activeStore';
import { useProjectsStore } from '@/features/projects/store';
import {
  fetchPollingStatus,
  type PollingStatus,
} from '@/features/projects/api';
import { formatRelative } from '@/features/executions/relativeTime';
import type { ExecutionLog, Project } from '@ia-flow/shared';

const RECENT_LIMIT = 15;

const router = useRouter();
const projectsStore = useProjectsStore();
const activeExecutionsStore = useActiveExecutionsStore();

const recent = ref<ExecutionLog[]>([]);
const recentLoading = ref(false);
const pollingByProject = ref<Record<string, PollingStatus | null>>({});

const activeByProject = computed(() => activeExecutionsStore.byProject);

const lastByProject = computed<Record<string, ExecutionLog | undefined>>(() => {
  const map: Record<string, ExecutionLog | undefined> = {};
  for (const e of recent.value) {
    if (!map[e.projectId]) map[e.projectId] = e;
  }
  return map;
});

async function loadRecent() {
  recentLoading.value = true;
  try {
    recent.value = await fetchExecutions({ limit: 200 });
  } finally {
    recentLoading.value = false;
  }
}

async function loadPollingSnapshot() {
  const entries = await Promise.all(
    projectsStore.projects.map(async (p) => {
      try {
        return [p.id, await fetchPollingStatus(p.id)] as const;
      } catch {
        return [p.id, null] as const;
      }
    }),
  );
  const map: Record<string, PollingStatus | null> = {};
  for (const [id, s] of entries) map[id] = s;
  pollingByProject.value = map;
}

onMounted(async () => {
  if (!activeExecutionsStore.loaded) await activeExecutionsStore.fetch();
  await loadRecent();
  await loadPollingSnapshot();
});

function goProject(id: string) {
  void router.push(`/projects/${id}/executions`);
}

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

function pollingDotClass(p: Project): string {
  const s = pollingByProject.value[p.id];
  if (s === undefined) return 'dv-dot dv-dot--gray';
  if (s === null) return 'dv-dot dv-dot--gray';
  return s.paused ? 'dv-dot dv-dot--red' : 'dv-dot dv-dot--green';
}
function pollingLabel(p: Project): string {
  const s = pollingByProject.value[p.id];
  if (s === undefined || s === null) return 'Sin polling';
  return s.paused ? 'Polling pausado' : 'Polling activo';
}
</script>

<template>
  <header class="dv-header">
    <h1>Dashboard</h1>
    <p>Estado operativo de todos los proyectos.</p>
  </header>

  <section class="dv-section">
    <div class="dv-section__title-row">
      <h2>Ejecuciones activas</h2>
      <span class="dv-badge">{{ activeExecutionsStore.activeCount }}</span>
    </div>
    <div v-if="activeExecutionsStore.activeCount === 0" class="dv-empty">
      No hay ejecuciones en curso.
    </div>
    <ul v-else class="dv-active-list">
      <li
        v-for="e in activeExecutionsStore.executions"
        :key="e.id"
        class="dv-active-item"
        @click="goProject(e.projectId)"
      >
        <span class="dv-dot dv-dot--green dv-dot--pulse" />
        <span class="dv-active-title">{{ e.taskTitle || e.taskId }}</span>
        <code class="dv-code">{{ e.projectId }}</code>
        <span class="dv-active-meta">{{ e.agentId }} · {{ formatRelative(e.startedAt) }}</span>
      </li>
    </ul>
  </section>

  <section class="dv-section">
    <div class="dv-section__title-row">
      <h2>Proyectos</h2>
      <button class="dv-link" @click="router.push('/projects')">Ver todos →</button>
    </div>
    <div v-if="!projectsStore.projects.length" class="dv-empty">Aún no hay proyectos.</div>
    <div v-else class="dv-projects-grid">
      <button
        v-for="p in projectsStore.projects"
        :key="p.id"
        class="dv-project-card"
        @click="goProject(p.id)"
      >
        <div class="dv-project-card__row">
          <span :class="pollingDotClass(p)" :title="pollingLabel(p)" />
          <span class="dv-project-card__name">{{ p.name }}</span>
          <span
            v-if="activeExecutionsStore.countForProject(p.id) > 0"
            class="dv-badge dv-badge--live"
          >
            {{ activeExecutionsStore.countForProject(p.id) }} corriendo
          </span>
        </div>
        <div class="dv-project-card__meta">
          <template v-if="lastByProject[p.id]">
            <span
              class="dv-outcome"
              :style="{ color: outcomeColor(lastByProject[p.id]!.outcome) }"
            >
              {{ outcomeSymbol(lastByProject[p.id]!.outcome) }}
              {{ lastByProject[p.id]!.outcome ?? 'en curso' }}
            </span>
            ·
            <span>{{ formatRelative(lastByProject[p.id]!.startedAt) }}</span>
          </template>
          <template v-else>
            <span class="dv-muted">Sin ejecuciones aún</span>
          </template>
        </div>
      </button>
    </div>
  </section>

  <section class="dv-section">
    <div class="dv-section__title-row">
      <h2>Últimas ejecuciones</h2>
      <button class="dv-link" @click="router.push('/general/ejecuciones')">Ver todas →</button>
    </div>
    <div v-if="recentLoading" class="dv-empty">Cargando…</div>
    <ul v-else-if="!recent.length" class="dv-empty">Aún no hay ejecuciones.</ul>
    <ul v-else class="dv-recent-list">
      <li
        v-for="e in recent.slice(0, RECENT_LIMIT)"
        :key="e.id"
        class="dv-recent-item"
        @click="goProject(e.projectId)"
      >
        <span
          class="dv-recent-outcome"
          :style="{ background: outcomeColor(e.outcome) }"
          :title="e.outcome ?? 'pending'"
        >
          {{ outcomeSymbol(e.outcome) }}
        </span>
        <span class="dv-recent-title">{{ e.taskTitle || e.taskId }}</span>
        <code class="dv-code">{{ e.projectId }}</code>
        <span class="dv-recent-meta">{{ e.agentId }} · {{ formatRelative(e.startedAt) }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.dv-header { display: flex; flex-direction: column; gap: 0.2rem; margin-bottom: 0.5rem; }
.dv-header h1 { margin: 0; font-size: 1.75rem; }
.dv-header p { margin: 0; color: #6b7280; font-size: 0.9rem; }

.dv-section { display: flex; flex-direction: column; gap: 0.75rem; }
.dv-section h2 { margin: 0; font-size: 1.05rem; color: #111827; }
.dv-section__title-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.dv-link {
  margin-left: auto;
  background: none;
  border: none;
  color: #2563eb;
  cursor: pointer;
  font-size: 0.85rem;
}

.dv-empty {
  padding: 1rem;
  color: #6b7280;
  background: #f9fafb;
  border-radius: 8px;
  text-align: center;
  font-size: 0.9rem;
}

.dv-badge {
  display: inline-flex;
  align-items: center;
  min-width: 22px;
  padding: 0 0.5rem;
  height: 20px;
  border-radius: 999px;
  background: #e5e7eb;
  color: #374151;
  font-size: 0.75rem;
  font-weight: 600;
}
.dv-badge--live {
  background: #dcfce7;
  color: #166534;
  margin-left: auto;
}

.dv-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dv-dot--green { background: #22c55e; box-shadow: 0 0 0 2px rgba(34,197,94,0.2); }
.dv-dot--red   { background: #ef4444; box-shadow: 0 0 0 2px rgba(239,68,68,0.2); }
.dv-dot--gray  { background: #9ca3af; box-shadow: 0 0 0 2px rgba(156,163,175,0.2); }
.dv-dot--pulse { animation: dv-pulse 1.6s ease-out infinite; }
@keyframes dv-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(34,197,94,0.6); }
  70%  { box-shadow: 0 0 0 8px rgba(34,197,94,0); }
  100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
}

.dv-active-list, .dv-recent-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.dv-active-item, .dv-recent-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem 0.75rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.88rem;
}
.dv-active-item:hover, .dv-recent-item:hover { background: #f9fafb; }
.dv-active-title, .dv-recent-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #111827;
}
.dv-active-meta, .dv-recent-meta { color: #6b7280; font-size: 0.8rem; white-space: nowrap; }
.dv-recent-outcome {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: #fff;
  font-size: 0.75rem;
  flex-shrink: 0;
}
.dv-code {
  background: #f3f4f6;
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  font-size: 0.7rem;
  color: #374151;
}
.dv-muted { color: #9ca3af; }

.dv-projects-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 0.75rem;
}
.dv-project-card {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.85rem 1rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  cursor: pointer;
  text-align: left;
}
.dv-project-card:hover { background: #f9fafb; }
.dv-project-card__row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.dv-project-card__name { font-weight: 600; color: #111827; flex-shrink: 0; }
.dv-project-card__meta { color: #6b7280; font-size: 0.8rem; }
.dv-outcome { font-weight: 500; }
</style>
