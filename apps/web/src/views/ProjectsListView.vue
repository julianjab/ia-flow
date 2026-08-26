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
    case 'success':   return 'var(--accent)';
    case 'error':     return 'var(--danger)';
    case 'cancelled': return 'var(--fg-dim)';
    case 'truncated': return 'var(--warn)';
    default:          return 'var(--fg-dim)';
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
  'github-projects': 'GitHub Projects',
  github: 'GitHub Projects',
  'github-issues': 'GitHub Repo',
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
  <div v-else class="pl-grid" data-kbd-list="projects">
    <button
      v-for="p in projectsStore.projects"
      :key="p.id"
      class="pl-card"
      data-kbd-item
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
  margin-bottom: 1rem;
}
.pl-header h1 {
  margin: 0 0 0.15rem;
  font-family: var(--font-mono);
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: var(--tracking-hd);
  text-transform: uppercase;
  color: var(--fg);
}
.pl-header p { margin: 0; color: var(--fg-mute); font-size: var(--fs-body-sm); }
.pl-add-btn {
  padding: 0 0.9rem;
  height: 26px;
  background: var(--accent);
  color: var(--panel);
  border: 1px solid var(--accent);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  font-weight: 700;
  cursor: pointer;
}
.pl-add-btn:hover { background: var(--green-hi); border-color: var(--green-hi); }

.pl-empty {
  padding: 1rem;
  color: var(--fg-dim);
  background: var(--panel);
  border: 1px solid var(--border);
  font-size: var(--fs-body-sm);
}

.pl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(520px, 100%), 1fr));
  gap: 1rem;
}
.pl-card {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1.15rem 1.25rem;
  min-height: 140px;
  background: var(--panel);
  border: 1px solid var(--border);
  text-align: left;
  cursor: pointer;
  font-family: var(--font-mono);
  color: var(--fg-mute);
  transition: border-color 0.1s ease, background 0.1s ease;
}
.pl-card:hover {
  background: var(--panel-hi);
  border-color: var(--border-hi);
  color: var(--fg);
}
.pl-card__title-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.pl-card__title {
  font-weight: 700;
  font-size: 1.05rem;
  color: var(--fg);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pl-card__id {
  background: transparent;
  padding: 0;
  font-size: var(--fs-chrome);
  color: var(--cyan);
}
.pl-card__meta {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  flex-wrap: wrap;
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
  margin-top: auto;
}
.pl-provider {
  display: inline-flex;
  align-items: center;
  padding: 0 0.4rem;
  font-size: var(--fs-chrome);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  border: 1px solid var(--border);
}
.pl-provider--github { color: var(--magenta); }
.pl-provider--local  { color: var(--fg-dim); }

.pl-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  flex-shrink: 0;
}
.pl-dot--green { background: var(--accent); animation: blink 1.6s ease-in-out infinite; }
.pl-dot--red   { background: var(--danger); }
.pl-dot--gray  { background: var(--fg-dimmer); }

.pl-live-badge {
  padding: 0 0.45rem;
  background: transparent;
  color: var(--accent);
  border: 1px solid var(--accent);
  font-size: var(--fs-chrome);
  font-weight: 700;
}
.pl-last { color: var(--fg-dim); font-size: var(--fs-chrome); }
</style>
