<script setup lang="ts">
import type { PullRequestRef, TaskRunSummary } from '@ia-flow/shared';
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { useProjectsStore } from '@/features/projects/store';
import { fetchProjectItems, type SourceItem } from '@/features/projects/sourceApi';
import { fetchBlockersBatch, fetchTaskRunSummaries } from '@/features/tasks/api';

/**
 * "Qué sigue" — la entrada por defecto del proyecto en mobile.
 *
 * La diferencia con el listado de Tareas no es el orden: es que cada fila dice
 * **por qué está ahí**. Un listado ordenado por fecha no ayuda a decidir qué
 * tocar; una cola que dice "falló 2 veces y no reintenta solo" sí.
 *
 * El orden lo calcula el CLIENTE por severidad. El handoff pide un endpoint
 * que resuma el proyecto y ordene la cola con un modelo (punto 3 de Requisitos
 * de backend); mientras no exista, esto ordena por severidad y **no dibuja la
 * card del resumen** en vez de inventarle un texto.
 */

const projectsStore = useProjectsStore();
const router = useRouter();

const items = ref<SourceItem[]>([]);
const runsByTask = ref<Record<string, TaskRunSummary>>({});
const blockersByTask = ref<Record<string, Array<{ id: string; ref?: string }>>>({});
const runsKnown = ref(false);
const loading = ref(false);
const error = ref('');

const activeProjectId = computed(() => projectsStore.activeProjectId);

async function load() {
  const pid = activeProjectId.value;
  if (!pid) return;
  loading.value = true;
  error.value = '';
  runsKnown.value = false;
  try {
    const res = await fetchProjectItems(pid);
    if (activeProjectId.value !== pid) return;
    if (res.error) {
      error.value = res.error;
      return;
    }
    items.value = res.items ?? [];
    const ids = items.value.map((i) => i.id);
    const [summaries, blockers] = await Promise.allSettled([
      fetchTaskRunSummaries(pid),
      fetchBlockersBatch(pid, ids),
    ]);
    if (activeProjectId.value !== pid) return;
    if (summaries.status === 'fulfilled') {
      const byTask: Record<string, TaskRunSummary> = {};
      for (const s of summaries.value) byTask[s.taskId] = s;
      runsByTask.value = byTask;
      runsKnown.value = true;
    }
    if (blockers.status === 'fulfilled') blockersByTask.value = blockers.value;
  } catch (e) {
    error.value = extractErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(activeProjectId, () => {
  items.value = [];
  runsByTask.value = {};
  blockersByTask.value = {};
  void load();
});

type Severity = 'failed' | 'blocked' | 'running' | 'idle' | 'rest';

interface QueueRow {
  id: string;
  title: string;
  issueNumber?: number;
  url?: string;
  severity: Severity;
  /** Por qué está en este puesto. Es lo que distingue esta pantalla de un
   *  listado ordenado por fecha. */
  reason: string;
  /** Qué hacer, cuando hay algo concreto. */
  action?: { label: string; url?: string };
}

/** El orden de la cola. Lo primero es lo que no avanza solo. */
const SEVERITY_RANK: Record<Severity, number> = {
  failed: 0,
  blocked: 1,
  running: 2,
  idle: 3,
  rest: 4,
};

function openPr(item: SourceItem): PullRequestRef | undefined {
  const prs = (item.meta?.pullRequests as PullRequestRef[] | undefined) ?? [];
  return prs.find((pr) => pr.state === 'open');
}

const queue = computed<QueueRow[]>(() => {
  const rows: QueueRow[] = items.value.map((item) => {
    const summary = runsByTask.value[item.id];
    const last = summary?.last;
    const blockers = blockersByTask.value[item.id] ?? [];
    const pr = openPr(item);
    const attemptsText = (summary?.attempts ?? 0) > 1 ? ` · ${summary?.attempts} intentos` : '';

    if (last && last.outcome === 'error') {
      return {
        id: item.id,
        title: item.title,
        issueNumber: item.meta?.issueNumber as number | undefined,
        url: item.meta?.issueUrl as string | undefined,
        severity: 'failed',
        reason: `✕ falló${last.failureClass ? ` · ${last.failureClass}` : ''}${attemptsText} · no reintenta solo`,
        // Aprobar/mergear desde la app no existe (punto 5): la acción abre el
        // PR en GitHub en vez de prometer un botón que no hace nada.
        ...(pr ? { action: { label: `Ver PR #${pr.number} ↗`, url: pr.url } } : {}),
      };
    }
    if (blockers.length) {
      const refs = blockers.map((b) => b.ref ?? b.id).slice(0, 2).join(', ');
      return {
        id: item.id,
        title: item.title,
        issueNumber: item.meta?.issueNumber as number | undefined,
        url: item.meta?.issueUrl as string | undefined,
        severity: 'blocked',
        reason: `⛔ bloqueada por ${refs}${last ? '' : ' · nunca se ejecutó'}`,
      };
    }
    if (last && !last.finishedAt) {
      return {
        id: item.id,
        title: item.title,
        issueNumber: item.meta?.issueNumber as number | undefined,
        url: item.meta?.issueUrl as string | undefined,
        severity: 'running',
        reason: `◐ corriendo · ${last.agentId}`,
      };
    }
    if (pr) {
      return {
        id: item.id,
        title: item.title,
        issueNumber: item.meta?.issueNumber as number | undefined,
        url: item.meta?.issueUrl as string | undefined,
        severity: 'rest',
        reason: `PR #${pr.number} abierto${pr.ci ? ` · CI ${pr.ci === 'success' ? '✓' : pr.ci}` : ''} · esperando review`,
        action: { label: `Ver PR #${pr.number} ↗`, url: pr.url },
      };
    }
    // Sin run y sabiéndolo: nunca arrancó. Sin saberlo, no se afirma.
    if (runsKnown.value && !last) {
      return {
        id: item.id,
        title: item.title,
        issueNumber: item.meta?.issueNumber as number | undefined,
        url: item.meta?.issueUrl as string | undefined,
        severity: 'idle',
        reason: '○ sin ejecutar',
      };
    }
    return {
      id: item.id,
      title: item.title,
      issueNumber: item.meta?.issueNumber as number | undefined,
      url: item.meta?.issueUrl as string | undefined,
      severity: 'rest',
      reason: '',
    };
  });

  return rows
    .filter((r) => r.reason)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
});

/** Los primeros tres son los accionables ahora: el número se pinta distinto
 *  para que la cola tenga un corte visible y no sea una lista infinita. */
const ACTIONABLE = 3;

function openTasks() {
  void router.push(`/projects/${activeProjectId.value}/tareas`);
}
</script>

<template>
  <section class="settings-section">
    <div class="section-header">
      <div class="section-head-text">
        <h2>Qué sigue</h2>
        <p class="section-desc">
          Qué tocar ahora, y por qué está ahí. Ordenado por lo que no avanza solo.
        </p>
      </div>
      <div class="section-head-actions">
        <span class="nu-count">{{ queue.length }} de {{ items.length }}</span>
        <button type="button" class="btn" :disabled="loading" @click="load()">
          <span class="btn-glyph">{{ loading ? '◐' : '↺' }}</span>
          {{ loading ? 'Cargando…' : 'Actualizar' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="nu-error">
      <p class="nu-error-line"><span class="nu-glyph">✕</span>{{ error }}</p>
      <p class="nu-error-fix"><span class="nu-glyph">→</span>Revisá el provider del proyecto y volvé a intentar.</p>
    </div>

    <p v-else-if="loading && !queue.length" class="nu-empty">Cargando…</p>
    <p v-else-if="!queue.length" class="nu-empty">No hay nada esperando: ninguna tarea falló, está bloqueada ni quedó sin correr.</p>

    <template v-else>
      <span class="uc-label nu-head">Cola priorizada</span>
      <ul class="nu-list">
        <li v-for="(row, i) in queue" :key="row.id" class="nu-row">
          <span class="nu-rank" :class="{ 'is-now': i < ACTIONABLE }">{{ i + 1 }}</span>
          <div class="nu-body">
            <p class="nu-title">
              {{ row.title }}
              <a
                v-if="row.issueNumber && row.url"
                class="nu-issue"
                :href="row.url"
                target="_blank"
                rel="noopener"
                @click.stop
              >#{{ row.issueNumber }}</a>
              <span v-else-if="row.issueNumber" class="nu-issue is-plain">#{{ row.issueNumber }}</span>
            </p>
            <p class="nu-reason" :class="`is-${row.severity}`">{{ row.reason }}</p>
            <a
              v-if="row.action?.url"
              class="nu-action"
              :href="row.action.url"
              target="_blank"
              rel="noopener"
            >→ {{ row.action.label }}</a>
          </div>
        </li>
      </ul>

      <button type="button" class="btn btn--ghost nu-all" @click="openTasks">
        ver las {{ items.length }} tareas →
      </button>
    </template>
  </section>
</template>

<style scoped>
.nu-count {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  white-space: nowrap;
}
.btn-glyph { color: var(--fg-dim); }
.nu-head { display: block; }
.nu-empty { margin: 0; font-size: var(--fs-body-sm); color: var(--fg-dim); }

.nu-error { display: flex; flex-direction: column; gap: 0.15rem; font-family: var(--font-mono); font-size: var(--fs-micro); }
.nu-error-line { margin: 0; color: var(--danger); overflow-wrap: anywhere; }
.nu-error-fix { margin: 0; color: var(--info); }
.nu-glyph { display: inline-block; width: 1.4ch; }

.nu-list { list-style: none; margin: 0; padding: 0; }
/* Sin zebra: la cola se lee de arriba abajo una vez, no se escanea como una
   tabla. El hairline alcanza para separar. */
.nu-row {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 0.55rem;
  padding: 0.5rem 0;
  align-items: baseline;
}
.nu-row + .nu-row { border-top: 1px solid var(--border-mute); }
.nu-rank {
  font-family: var(--font-mono);
  font-size: var(--fs-chrome);
  color: var(--fg-dim);
}
/* Los primeros tres son los accionables ahora: el corte tiene que verse. */
.nu-rank.is-now { color: var(--accent); }

.nu-body { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.nu-title {
  margin: 0;
  font-size: var(--fs-body);
  line-height: 1.4;
  color: var(--fg);
  text-wrap: pretty;
  overflow-wrap: anywhere;
}
.nu-issue {
  margin-left: 0.35rem;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dimmer);
  text-decoration: none;
}
/* Sin esto el `a:hover` global lo pinta de teal entero. */
.nu-issue:hover:not(.is-plain) { background: transparent; color: var(--info); }

.nu-reason {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  overflow-wrap: anywhere;
}
.nu-reason.is-failed { color: var(--danger); }
.nu-reason.is-blocked { color: var(--warn); }
.nu-reason.is-running { color: var(--accent); }
.nu-reason.is-idle { color: var(--fg-dimmer); }

.nu-action {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--info);
  text-decoration: none;
}
.nu-action:hover { background: transparent; color: var(--info); text-decoration: underline; }

.nu-all { align-self: flex-start; font-family: var(--font-mono); }
</style>
