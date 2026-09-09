<script setup lang="ts">
import type { ExecutionLog } from '@ia-flow/shared';
import { computed, ref, watch } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { fetchTaskExecutions } from '@/features/tasks/api';
import TaskPipelineSteps from '@/components/TaskPipelineSteps.vue';

const props = defineProps<{
  projectId: string | null;
  taskId: string | null;
  /** Cambia cuando algo pudo haber agregado un run (un "Correr ahora"): el
   *  listado se recarga solo en vez de obligar a cerrar y abrir el detalle. */
  reloadToken?: unknown;
  /** El pipeline en orden, para dibujar la barra de pasos arriba de la lista.
   *  Sin esto (fuente sin noción de pipeline, ej. local-fs) no hay stepper,
   *  pero la lista de runs igual arranca colapsada. */
  pipelineStatuses?: string[];
  /** Status actual de la tarea — contra qué se resalta el paso "en curso". */
  currentStatus?: string | null;
}>();

const executions = ref<ExecutionLog[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

const hasPipeline = computed(() => (props.pipelineStatuses?.length ?? 0) > 0);
// El detalle fila por fila es secundario frente al resumen (stepper si hay
// pipeline, o la sola cantidad de runs si no) — arranca colapsado siempre.
const expanded = ref(false);

async function load() {
  if (!props.projectId || !props.taskId) return;
  loading.value = true;
  error.value = null;
  const taskId = props.taskId;
  try {
    const rows = await fetchTaskExecutions(props.projectId, taskId, 10);
    // El detalle puede haber cambiado de tarea mientras esto volaba.
    if (props.taskId === taskId) executions.value = rows;
  } catch (e) {
    if (props.taskId === taskId) error.value = extractErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

watch(() => [props.taskId, props.reloadToken], load, { immediate: true });

/** Un run sin `finishedAt` sigue vivo — es lo que distingue "corriendo" de un
 *  outcome, y el motivo de que la fila no muestre duración todavía. */
function isRunning(e: ExecutionLog): boolean {
  return !e.finishedAt;
}

function outcomeLabel(e: ExecutionLog): string {
  if (isRunning(e)) return 'corriendo';
  return e.outcome ?? 'sin outcome';
}

function startedLabel(e: ExecutionLog): string {
  const d = new Date(e.startedAt);
  return Number.isNaN(d.getTime())
    ? e.startedAt
    : d.toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function durationLabel(e: ExecutionLog): string | null {
  const ms =
    e.durationMs ??
    (e.finishedAt ? new Date(e.finishedAt).getTime() - new Date(e.startedAt).getTime() : null);
  if (ms === null || Number.isNaN(ms) || ms < 0) return null;
  // Se redondea a segundos ANTES de partir en minutos: redondear el resto por
  // separado daba "1m 60s" para cualquier duración entre 1m59.5s y 2m.
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
}

/** Por qué terminó así, si el run dejó alguna pista.
 *
 *  Recortado: `errorMsg` puede traer la respuesta cruda del modelo (un run
 *  truncado por `pause_turn` dejó una de 29 KB), y meterla entera en el DOM y
 *  en un `title` no la hace más legible — para el detalle completo está la
 *  sección de Ejecuciones. */
const MAX_REASON = 160;
function reasonOf(e: ExecutionLog): string | null {
  const raw = e.errorMsg ?? e.failureClass ?? e.stopReason;
  if (!raw) return null;
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_REASON ? `${flat.slice(0, MAX_REASON)}…` : flat;
}

/** Una fila puede ser un run de agente o una acción de la regla (notificar,
 *  script). Se distinguen porque responden preguntas distintas: "qué hizo el
 *  agente" y "qué disparó el pipeline alrededor". */
function isAction(e: ExecutionLog): boolean {
  return (e.kind ?? 'agent') !== 'agent';
}

/** `/projects/:id/executions?runId=<id>` — mismo mecanismo que `?runId=` de
 *  `ExecutionsSection` (ver `jumpToRun`): abre esa pantalla con esta fila ya
 *  expandida, en vez de duplicar acá el detalle completo del run. */
function runHref(e: ExecutionLog): string {
  return `/projects/${e.projectId}/executions?runId=${encodeURIComponent(e.id)}`;
}
</script>

<template>
  <section class="runs-block">
    <div class="runs-head">
      <span class="uc-label">Qué hizo</span>
      <button type="button" class="runs-reload" :disabled="loading" @click="load()">
        {{ loading ? '◐' : '↻' }}
      </button>
    </div>

    <TaskPipelineSteps
      v-if="hasPipeline"
      :statuses="pipelineStatuses ?? []"
      :current-status="currentStatus"
      :executions="executions"
    />

    <p v-if="error" class="runs-error">No se pudieron cargar: {{ error }}</p>
    <p v-else-if="loading && !executions.length" class="empty">Cargando…</p>
    <p v-else-if="!executions.length" class="empty">Todavía no hizo nada: ningún agente corrió sobre esta tarea.</p>

    <!-- El detalle fila por fila queda un click abajo: si hay stepper, la
         barra ya contesta "¿en qué va?"; si no, alcanza con saber cuántos
         runs hubo antes de pedir el motivo puntual de cada uno. -->
    <button
      v-if="executions.length"
      type="button"
      class="runs-toggle"
      @click="expanded = !expanded"
    >{{ expanded ? '▾' : '▸' }} ver ejecuciones ({{ executions.length }})</button>

    <ul v-if="expanded && executions.length" class="runs-list">
      <li v-for="e in executions" :key="e.id" class="run-row">
        <RouterLink
          class="run-outcome"
          :class="`is-${isRunning(e) ? 'running' : (e.outcome ?? 'unknown')}`"
          :to="runHref(e)"
          :title="'Ver la ejecución'"
        >{{ outcomeLabel(e) }}</RouterLink>
        <span class="run-agent" :class="{ 'is-action': isAction(e) }" :title="e.providerId || e.kind">
          {{ e.agentId }}
        </span>
        <span class="run-when">{{ startedLabel(e) }}</span>
        <span v-if="durationLabel(e)" class="run-duration">{{ durationLabel(e) }}</span>
        <span v-if="reasonOf(e)" class="run-reason" :title="reasonOf(e) ?? undefined">
          {{ reasonOf(e) }}
        </span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.runs-block {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--border);
}
.runs-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.runs-reload {
  background: none;
  border: none;
  color: var(--fg-dim);
  cursor: pointer;
  font-size: var(--fs-chrome);
  padding: 0 0.2rem;
  line-height: 1;
}
.runs-reload:hover:not(:disabled) { color: var(--fg); }
.runs-reload:disabled { cursor: default; }

/* `min-width: 0`: sin esto, este `<ul>` es un hijo flex de `.runs-block` con
 * el default `min-width: auto`, y aunque cada `.run-row` ya se puede achicar
 * a 0, ESTE nivel intermedio de la cadena no hereda ese override solo —
 * mismo patrón que `.modal-body > *` en TaskDetailModal.vue. */
.runs-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
/* Dos líneas SIEMPRE, no sólo en un teléfono: esta lista vive dentro del panel
   de detalle, que mide 400px en escritorio y la pantalla completa en mobile —
   nunca es ancha. En una línea, los cuatro campos de ancho fijo sumaban 377px
   dentro de una caja de 345 y la duración quedaba cortada contra el borde: no
   scrolleable, no truncada, simplemente invisible.

   El reparto es el mismo de toda fila de datos de la app: identidad arriba
   (resultado · agente · duración), contexto abajo (cuándo · por qué). */
.run-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas:
    'outcome agent  dur'
    'when    reason reason';
  align-items: baseline;
  gap: 0.1rem 0.5rem;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}
.run-outcome {
  grid-area: outcome;
  flex: 0 0 auto;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: var(--tracking-hd);
  text-decoration: none;
}
/* `background: transparent` porque si no el `a:hover` global lo pinta de
   teal entero; el color de cada outcome se repite en su propio `:hover`
   porque, si no, ese mismo `a:hover` global también se lo pisa a `--panel` —
   el color del outcome es información (éxito/fallo/cancelado), no algo que
   deba cambiar sólo porque el mouse está encima. */
.run-outcome:hover { text-decoration: underline; background: transparent; }
.is-success { color: var(--accent); }
.is-success:hover { color: var(--accent); }
.is-error { color: var(--danger); }
.is-error:hover { color: var(--danger); }
/* Cancelado y truncado no son fallos del agente: uno lo pidió una persona y el
   otro es un límite del run. Se distinguen del rojo a propósito. */
.is-cancelled,
.is-truncated { color: var(--warn); }
.is-cancelled:hover,
.is-truncated:hover { color: var(--warn); }
.is-running { color: var(--info); }
.is-running:hover { color: var(--info); }
.run-agent {
  grid-area: agent;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
  font-family: var(--font-mono);
}
/* Una acción de la regla no es un run de agente: se lee, no se analiza. */
.run-agent.is-action { color: var(--fg-dim); font-family: inherit; font-style: italic; }
.run-when { grid-area: when; white-space: nowrap; }
.run-duration { grid-area: dur; white-space: nowrap; font-variant-numeric: tabular-nums; }
/* El motivo es lo primero que se recorta: identidad y resultado del run tienen
   que sobrevivir a cualquier ancho. */
.run-reason {
  grid-area: reason;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* `--fg-dimmer` sobre `--panel` da 2.52:1 — falla el mínimo de 4.5:1 (R6).
   * `--fg-dim` es el tono más oscuro de esta paleta que sigue pasando. */
  color: var(--fg-dim);
}
.runs-toggle {
  align-self: flex-start;
  background: none;
  border: none;
  padding: 0;
  color: var(--fg-dim);
  font-size: var(--fs-micro);
  cursor: pointer;
}
.runs-toggle:hover { color: var(--fg); }
.empty { margin: 0; font-size: var(--fs-chrome); color: var(--fg-dim); }
.runs-error { margin: 0; font-size: var(--fs-chrome); color: var(--danger); }
</style>
