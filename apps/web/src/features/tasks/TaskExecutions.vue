<script setup lang="ts">
import type { ExecutionLog } from '@ia-flow/shared';
import { ref, watch } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { fetchTaskExecutions } from '@/features/tasks/api';

const props = defineProps<{
  projectId: string | null;
  taskId: string | null;
  /** Cambia cuando algo pudo haber agregado un run (un "Correr ahora"): el
   *  listado se recarga solo en vez de obligar a cerrar y abrir el detalle. */
  reloadToken?: unknown;
}>();

const executions = ref<ExecutionLog[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

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
</script>

<template>
  <section class="runs-block">
    <div class="runs-head">
      <span class="uc-label">Ejecuciones</span>
      <button type="button" class="runs-reload" :disabled="loading" @click="load()">
        {{ loading ? '◐' : '↻' }}
      </button>
    </div>

    <p v-if="error" class="runs-error">No se pudieron cargar: {{ error }}</p>
    <p v-else-if="loading && !executions.length" class="empty">Cargando…</p>
    <p v-else-if="!executions.length" class="empty">Esta tarea todavía no corrió ningún agente.</p>

    <ul v-else class="runs-list">
      <li v-for="e in executions" :key="e.id" class="run-row">
        <span class="run-outcome" :class="`is-${isRunning(e) ? 'running' : (e.outcome ?? 'unknown')}`">
          {{ outcomeLabel(e) }}
        </span>
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

.runs-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.run-row {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}
.run-outcome {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: var(--tracking-hd);
}
.is-success { color: var(--ok, #2e9e5b); }
.is-error { color: var(--danger, #c0392b); }
/* Cancelado y truncado no son fallos del agente: uno lo pidió una persona y el
   otro es un límite del run. Se distinguen del rojo a propósito. */
.is-cancelled,
.is-truncated { color: var(--warn, #b7791f); }
.is-running { color: var(--info); }
.run-agent { flex: 0 0 auto; color: var(--fg); font-family: var(--font-mono); }
/* Una acción de la regla no es un run de agente: se lee, no se analiza. */
.run-agent.is-action { color: var(--fg-dim); font-family: inherit; font-style: italic; }
.run-when { flex: 0 0 auto; }
.run-duration { flex: 0 0 auto; }
/* El motivo es lo primero que se recorta: identidad y resultado del run tienen
   que sobrevivir a cualquier ancho. */
.run-reason {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-dimmer);
}
.empty { margin: 0; font-size: var(--fs-chrome); color: var(--fg-dimmer); }
.runs-error { margin: 0; font-size: var(--fs-chrome); color: var(--danger, #c0392b); }
</style>
