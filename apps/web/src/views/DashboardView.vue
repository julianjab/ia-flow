<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { fetchExecutions } from '@/features/executions/api';
import { useActiveExecutionsStore } from '@/features/executions/activeStore';
import { useProjectsStore } from '@/features/projects/store';
import { fetchPollingStatus, type PollingStatus } from '@/features/projects/api';
import { formatRelative } from '@/features/executions/relativeTime';
import type { ExecutionLog, Project } from '@ia-flow/shared';

const RECENT_LIMIT = 12;

const router = useRouter();
const projectsStore = useProjectsStore();
const activeExecutionsStore = useActiveExecutionsStore();

const recent = ref<ExecutionLog[]>([]);
const recentLoading = ref(false);
const pollingByProject = ref<Record<string, PollingStatus | null>>({});
const now = ref(Date.now());

// A 1Hz clock — only alive while at least one run is in-flight — keeps the
// elapsed counter fresh without a permanent timer on an idle page.
let tickId: ReturnType<typeof setInterval> | null = null;
function ensureTicker(shouldRun: boolean) {
  if (shouldRun && tickId === null) {
    tickId = setInterval(() => { now.value = Date.now(); }, 1000);
  } else if (!shouldRun && tickId !== null) {
    clearInterval(tickId);
    tickId = null;
  }
}
onBeforeUnmount(() => ensureTicker(false));

const lastByProject = computed<Record<string, ExecutionLog | undefined>>(() => {
  const map: Record<string, ExecutionLog | undefined> = {};
  for (const e of recent.value) if (!map[e.projectId]) map[e.projectId] = e;
  return map;
});

// Windowed counters — 24h back from now(). Cheap on the client side because
// `recent` is capped at 200.
const CUTOFF_MS = 24 * 60 * 60 * 1000;
const recent24h = computed(() =>
  recent.value.filter((e) => Date.parse(e.startedAt) >= now.value - CUTOFF_MS),
);
const successCount24h = computed(() => recent24h.value.filter((e) => e.outcome === 'success').length);
const failCount24h = computed(() => recent24h.value.filter((e) => e.outcome === 'error').length);
const cancelledCount24h = computed(() => recent24h.value.filter((e) => e.outcome === 'cancelled' || e.outcome === 'truncated').length);
const activeProjectsCount = computed(() => {
  let n = 0;
  for (const p of projectsStore.projects) {
    const s = pollingByProject.value[p.id];
    if (s && !s.paused) n++;
  }
  return n;
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
      try { return [p.id, await fetchPollingStatus(p.id)] as const; }
      catch { return [p.id, null] as const; }
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
  ensureTicker(activeExecutionsStore.activeCount > 0);
});

function goProject(id: string) { void router.push(`/projects/${id}/executions`); }
// Click on an execution row (either "EN EJECUCIÓN" or "ACTIVIDAD"): land in
// the project's executions tab with the run already selected, so the drawer
// auto-opens instead of forcing the operator to hunt for the row.
function goExecution(e: ExecutionLog) {
  void router.push({ path: `/projects/${e.projectId}/executions`, query: { runId: e.id } });
}
function goAllExecutions() { void router.push('/general/ejecuciones'); }
function goProjects() { void router.push('/projects'); }

// One-glyph outcome legend — same shape used across the app.
function outcomeGlyph(o: ExecutionLog['outcome']): string {
  switch (o) {
    case 'success':   return '✓';
    case 'error':     return '✕';
    case 'cancelled': return '⊘';
    case 'truncated': return '…';
    default:          return '◐';
  }
}
function outcomeVar(o: ExecutionLog['outcome']): string {
  switch (o) {
    case 'success':   return 'var(--accent)';
    case 'error':     return 'var(--danger)';
    case 'cancelled': return 'var(--fg-dim)';
    case 'truncated': return 'var(--warn)';
    default:          return 'var(--warn)';
  }
}

function pollingGlyph(p: Project): string {
  const s = pollingByProject.value[p.id];
  if (s === undefined || s === null) return '·';
  return s.paused ? '○' : '●';
}
function pollingVar(p: Project): string {
  const s = pollingByProject.value[p.id];
  if (s === undefined || s === null) return 'var(--fg-dimmer)';
  return s.paused ? 'var(--danger)' : 'var(--accent)';
}
function pollingText(p: Project): string {
  const s = pollingByProject.value[p.id];
  if (s === undefined || s === null) return 'sin polling';
  return s.paused ? 'pausado' : 'activo';
}

// Elapsed since `startedAt`, formatted like the mock (`04:12` / `1h 04m`).
function elapsed(iso: string): string {
  const ms = Math.max(0, now.value - Date.parse(iso));
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  return `${m.toString().padStart(2, '0')}:${rem.toString().padStart(2, '0')}`;
}
</script>

<template>
  <!-- ═══ Prompt line ═══ -->
  <div class="prompt">
    <span class="prompt__arrow">➜</span>
    <span class="prompt__path">~/ia-flow</span>
    <span class="prompt__cmd">status</span>
    <span class="prompt__hint">— {{ projectsStore.projects.length }} proyectos · {{ activeExecutionsStore.activeCount }} corriendo</span>
  </div>

  <!-- ═══ Tiles ═══ -->
  <section class="tiles">
    <div class="tile">
      <div class="tile__hd">
        <span class="live-dot" v-if="activeExecutionsStore.activeCount > 0" />
        <span class="uc-label">en ejecución</span>
      </div>
      <span class="tile__val tile__val--accent">{{ activeExecutionsStore.activeCount }}</span>
      <span class="tile__note">runs abiertos</span>
    </div>
    <div class="tile">
      <div class="tile__hd"><span class="uc-label">proyectos activos</span></div>
      <span class="tile__val">{{ activeProjectsCount }}<span class="tile__val-sub"> / {{ projectsStore.projects.length }}</span></span>
      <span class="tile__note">polling encendido</span>
    </div>
    <div class="tile">
      <div class="tile__hd"><span class="uc-label">éxitos 24h</span></div>
      <span class="tile__val">{{ successCount24h }}</span>
      <span class="tile__note">outcome=success</span>
    </div>
    <div class="tile">
      <div class="tile__hd"><span class="uc-label">fallos 24h</span></div>
      <span class="tile__val" :style="{ color: failCount24h > 0 ? 'var(--danger)' : 'var(--fg-dim)' }">{{ failCount24h }}</span>
      <span class="tile__note">
        <template v-if="cancelledCount24h > 0">+ {{ cancelledCount24h }} canceladas/truncadas</template>
        <template v-else>outcome=error</template>
      </span>
    </div>
  </section>

  <!-- ═══ En ejecución + Proyectos ═══ -->
  <section class="split">
    <!-- En ejecución -->
    <div class="panel">
      <div class="panel__header">
        <span class="live-dot" v-if="activeExecutionsStore.activeCount > 0" />
        <span>EN EJECUCIÓN</span>
        <span class="panel__meta">{{ activeExecutionsStore.activeCount }} activos</span>
      </div>

      <div v-if="activeExecutionsStore.activeCount === 0" class="empty">· sin runs abiertos</div>

      <div v-else class="run-list" data-kbd-list="dashboard-runs">
        <div
          v-for="e in activeExecutionsStore.executions"
          :key="e.id"
          class="run"
          data-kbd-item
          tabindex="0"
          @click="goExecution(e)"
        >
          <div class="run__row">
            <span class="run__glyph">◐</span>
            <span class="run__title">{{ e.taskTitle || e.taskId }}</span>
            <span class="run__elapsed">{{ elapsed(e.startedAt) }}</span>
          </div>
          <div class="run__grid">
            <span class="run__k">agente</span>
            <span class="run__v run__v--accent">{{ e.agentId }}</span>
            <span class="run__k">provider</span>
            <span class="run__v run__v--cyan">{{ e.providerId }}</span>
            <span class="run__k">proyecto</span>
            <span class="run__v run__v--cyan">{{ e.projectId }}</span>
            <span class="run__k">task</span>
            <span class="run__v">{{ e.taskId }}</span>
          </div>
        </div>
      </div>

      <div class="panel__kbdbar">
        <span class="kbd kbd--primary">⏎</span>
        <span>abrir</span>
        <span class="kbd">j/k</span>
        <span>navegar</span>
        <span style="margin-left:auto">
          <a class="kbd-link" @click.prevent="goAllExecutions">ver todas →</a>
        </span>
      </div>
    </div>

    <!-- Proyectos -->
    <div class="panel">
      <div class="panel__header">
        <span>PROYECTOS</span>
        <span class="panel__meta">{{ projectsStore.projects.length }} total</span>
      </div>

      <div v-if="!projectsStore.projects.length" class="empty">· aún no hay proyectos</div>

      <div v-else class="table" data-kbd-list="dashboard-projects">
        <div class="table__head">
          <span></span>
          <span>nombre</span>
          <span>último ciclo</span>
          <span style="text-align:right">corriendo</span>
        </div>
        <div
          v-for="p in projectsStore.projects"
          :key="p.id"
          class="table__row"
          data-kbd-item
          tabindex="0"
          @click="goProject(p.id)"
        >
          <span class="table__glyph" :style="{ color: pollingVar(p) }">{{ pollingGlyph(p) }}</span>
          <span class="table__cell table__cell--name">
            <span class="table__name">{{ p.name }}</span>
            <span class="table__id">{{ p.id }}</span>
          </span>
          <span class="table__cell">
            <template v-if="lastByProject[p.id]">
              <span :style="{ color: outcomeVar(lastByProject[p.id]!.outcome) }">
                {{ outcomeGlyph(lastByProject[p.id]!.outcome) }}
              </span>
              <span class="table__meta"> {{ formatRelative(lastByProject[p.id]!.startedAt) }}</span>
            </template>
            <template v-else>
              <span class="table__meta">· {{ pollingText(p) }}</span>
            </template>
          </span>
          <span class="table__cell table__cell--right">
            <template v-if="activeExecutionsStore.countForProject(p.id) > 0">
              <span style="color: var(--accent)">● {{ activeExecutionsStore.countForProject(p.id) }}</span>
            </template>
            <template v-else>
              <span class="table__meta">·</span>
            </template>
          </span>
        </div>
      </div>

      <div class="panel__kbdbar">
        <span class="kbd kbd--primary">⏎</span>
        <span>abrir</span>
        <span style="margin-left:auto">
          <a class="kbd-link" @click.prevent="goProjects">gestionar →</a>
        </span>
      </div>
    </div>
  </section>

  <!-- ═══ Actividad ═══ -->
  <section class="panel">
    <div class="panel__header">
      <span>ACTIVIDAD</span>
      <span class="panel__meta">websocket · en vivo</span>
      <span class="panel__meta" style="margin-left:auto">{{ recent.length }} runs en 200</span>
    </div>

    <div class="log" data-kbd-list="dashboard-activity">
      <div class="log__head">
        <span>hora</span>
        <span></span>
        <span>agente</span>
        <span>proyecto</span>
        <span>tarea</span>
        <span style="text-align:right">t</span>
      </div>
      <div v-if="recentLoading" class="empty">· cargando…</div>
      <div v-else-if="!recent.length" class="empty">· sin ejecuciones registradas</div>
      <div
        v-for="e in recent.slice(0, RECENT_LIMIT)"
        :key="e.id"
        class="log__row"
        data-kbd-item
        tabindex="0"
        @click="goExecution(e)"
      >
        <span class="log__time">{{ new Date(e.startedAt).toISOString().slice(11, 19) }}</span>
        <span :style="{ color: outcomeVar(e.outcome) }">{{ outcomeGlyph(e.outcome) }}</span>
        <span class="log__agent">{{ e.agentId }}</span>
        <span class="log__project">{{ e.projectId }}</span>
        <span class="log__task">{{ e.taskTitle || e.taskId }}</span>
        <span class="log__dur">{{ formatRelative(e.startedAt) }}</span>
      </div>
    </div>

    <div class="panel__kbdbar">
      <span class="kbd kbd--primary">⏎</span>
      <span>ver detalle</span>
      <span style="margin-left:auto">
        <a class="kbd-link" @click.prevent="goAllExecutions">tail -f completo →</a>
      </span>
    </div>
  </section>
</template>

<style scoped>
/* Prompt line at the top — the "you are here" of the console. */
.prompt {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  font-size: var(--fs-body-sm);
  color: var(--fg-dim);
}
.prompt__arrow { color: var(--accent); }
.prompt__path { color: var(--cyan); }
.prompt__cmd { color: var(--fg); }
.prompt__hint { color: var(--fg-dimmer); }

/* Tiles: 1px grid of KPI cells. */
.tiles {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  background: var(--border);
  border: 1px solid var(--border);
}
.tile {
  background: var(--panel);
  padding: 0.9rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}
.tile__hd { display: flex; align-items: center; gap: 0.4rem; }
.tile__val {
  font-size: 2.2rem;
  font-weight: 700;
  line-height: 1;
  color: var(--fg);
}
.tile__val--accent { color: var(--accent); }
.tile__val-sub { color: var(--fg-dimmer); font-size: 1rem; font-weight: 400; }
.tile__note { font-size: var(--fs-chrome); color: var(--fg-dim); line-height: 1.5; }

/* Two-column split for panels. */
.split {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: 1rem;
  align-items: start;
}
@media (max-width: 900px) {
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .split { grid-template-columns: 1fr; }
  /* El `minmax(0, …)` deja que la COLUMNA encoja, pero el panel adentro sigue
     con su ancho mínimo de contenido (433px). Sin este `min-width: 0` la
     columna se achica y el panel se le sale igual. */
  .split > .panel, .panel { min-width: 0; }
}

/* Panel + header — global .panel/.panel__header used here as scoped-friendly. */
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}
.panel__header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0.75rem;
  background: var(--panel-hi);
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-chrome);
  letter-spacing: var(--tracking-hd);
  color: var(--fg);
}
.panel__meta { color: var(--fg-dim); font-weight: 400; letter-spacing: 0; text-transform: none; }
.panel__kbdbar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.35rem 0.75rem;
  border-top: 1px solid var(--border);
  background: var(--panel-hi);
  font-size: var(--fs-chrome);
  color: var(--fg-dim);
}
.kbd-link { cursor: pointer; }

.empty {
  padding: 0.85rem 0.75rem;
  color: var(--fg-dimmer);
  font-size: var(--fs-body-sm);
}

/* Run cards inside "En ejecución". */
.run-list { display: flex; flex-direction: column; }
.run {
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--border-mute);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.run:last-child { border-bottom: none; }
.run:hover { background: var(--panel-hi); }
.run__row { display: flex; align-items: baseline; gap: 0.6rem; }
.run__glyph { color: var(--warn); animation: blink 1.6s ease-in-out infinite; }
.run__title { flex: 1; color: var(--fg); font-size: var(--fs-body); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run__elapsed { color: var(--warn); font-size: var(--fs-body-sm); font-variant-numeric: tabular-nums; }
.run__grid {
  display: grid;
  grid-template-columns: 10ch 1fr;
  gap: 0.15rem 0.75rem;
  font-size: var(--fs-body-sm);
}
.run__k { color: var(--fg-dim); }
.run__v { color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run__v--accent { color: var(--accent); }
.run__v--cyan { color: var(--cyan); }

/* Table primitive — used by projects list. */
.table { display: flex; flex-direction: column; font-size: var(--fs-body-sm); }
.table__head {
  display: grid;
  grid-template-columns: 3ch 1fr 22ch 12ch;
  gap: 0.75rem;
  padding: 0.3rem 0.75rem;
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dimmer);
}
.table__row {
  display: grid;
  grid-template-columns: 3ch 1fr 22ch 12ch;
  gap: 0.75rem;
  align-items: center;
  padding: 0 0.75rem;
  height: var(--row-h);
  border-bottom: 1px solid var(--border-mute);
  cursor: pointer;
  color: var(--fg-dim);
}
.table__row:hover { background: var(--panel-hi); color: var(--fg); }
.table__row:last-child { border-bottom: none; }
.table__glyph { text-align: center; }
.table__cell { display: flex; align-items: center; gap: 0.4rem; min-width: 0; overflow: hidden; }
.table__cell--right { justify-content: flex-end; }
.table__cell--name { gap: 0.75rem; }
.table__name { color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.table__id { color: var(--fg-dimmer); font-size: var(--fs-chrome); overflow: hidden; text-overflow: ellipsis; }
.table__meta { color: var(--fg-dimmer); }

/* Activity log — tail-style feed. */
.log { font-size: var(--fs-body-sm); }
.log__head {
  display: grid;
  grid-template-columns: 9ch 3ch 14ch 14ch 1fr 12ch;
  gap: 0.75rem;
  padding: 0.3rem 0.75rem;
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dimmer);
}
.log__row {
  display: grid;
  grid-template-columns: 9ch 3ch 14ch 14ch 1fr 12ch;
  gap: 0.75rem;
  padding: 0 0.75rem;
  height: var(--row-h);
  align-items: center;
  border-bottom: 1px solid var(--border-mute);
  cursor: pointer;
  color: var(--fg-dim);
}
.log__row:hover { background: var(--panel-hi); color: var(--fg); }
.log__row:last-child { border-bottom: none; }
.log__time { color: var(--fg-dimmer); font-variant-numeric: tabular-nums; }
.log__agent { color: var(--cyan); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log__project { color: var(--magenta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log__task { color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log__dur { color: var(--fg-dimmer); text-align: right; }

@media (max-width: 768px) {
  /* Una tabla no se apila: `3ch 1fr 22ch 12ch` es info tabular, y apilarla la
     vuelve una lista de pares que no se puede escanear. Scrollea dentro de su
     caja para que la PÁGINA no scrollee — que es lo que rompía la lectura en
     el celular. */
  .table, .log { overflow-x: auto; }
  /* La grilla del log es `9ch 3ch 14ch 14ch 1fr 12ch` con gaps: ~54ch. Un
     min-width menor deja que el `1fr` se comprima y las columnas se pisen. */
  .table__head, .table__row { min-width: 46ch; }
  .log__head, .log__row { min-width: 54ch; }
}
</style>