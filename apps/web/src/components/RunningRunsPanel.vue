<script setup lang="ts">
import type { ExecutionLog } from '@ia-flow/shared';
import { computed } from 'vue';
import { useNow } from '@/composables/useNow';
import { useActiveExecutionsStore } from '@/features/executions/activeStore';

/**
 * Los runs EN VUELO.
 *
 * La lista de ejecuciones responde "qué pasó"; esto responde "qué está pasando
 * ahora", que es otra pregunta y por eso es otra caja: una fila más en una
 * tabla ordenada por fecha se lee igual que una vieja, y lo que está corriendo
 * es lo único sobre lo que todavía se puede actuar.
 *
 * Vive en `components/` y no en `features/executions/` porque lo comparten dos
 * pantallas de dos features: Ejecuciones (arriba del historial) y Qué sigue (la
 * columna derecha del frame 3b, "la cola y lo que corre, en la misma vista").
 * Una feature no importa de otra, así que lo que comparten dos sube acá.
 */
const props = defineProps<{
  /** `null` = vista global (todas las ejecuciones del server). */
  projectId: string | null;
}>();

const emit = defineEmits<{
  /** Abrir el detalle de ese run en la lista de abajo. */
  open: [runId: string];
  cancel: [run: ExecutionLog];
}>();

const store = useActiveExecutionsStore();
const { now } = useNow();

const runs = computed<ExecutionLog[]>(() =>
  props.projectId
    ? (store.byProject[props.projectId] ?? [])
    : store.executions,
);

/** La duración corre desde `startedAt` y sigue corriendo sin WS: congelarla
 *  haría parecer que el run se colgó. */
function elapsed(run: ExecutionLog): string {
  const total = Math.max(0, Math.round((now.value - new Date(run.startedAt).getTime()) / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

/** Quién y con qué. El número de issue va primero porque es el ancla. */
function meta(run: ExecutionLog): string {
  const issue = run.taskId.startsWith('I_') ? null : run.taskId;
  return [issue, run.agentId, run.providerId, run.model].filter(Boolean).join(' · ');
}
</script>

<template>
  <section v-if="runs.length" class="rr">
    <span class="uc-label">En vuelo</span>
    <ul class="rr-list">
      <li v-for="run in runs" :key="run.id" class="rr-card">
        <div class="rr-head">
          <span class="live-dot" aria-hidden="true"></span>
          <span class="rr-title" :title="run.taskTitle">{{ run.taskTitle }}</span>
          <!-- La duración de un run vivo va en --warn: no es un dato neutro,
               es el que dice si algo se está yendo de tiempo. -->
          <span class="rr-elapsed">{{ elapsed(run) }}</span>
        </div>
        <p class="rr-meta">{{ meta(run) }}</p>
        <!-- Sin barra de pasos: `execution_logs` guarda una fila por run, no
             pasos (ver "Requisitos de backend"). Un `3/5` acá sería inventado. -->
        <div class="rr-actions">
          <button type="button" class="btn btn--ghost" @click="emit('open', run.id)">
            Ver logs
          </button>
          <button type="button" class="btn btn--danger" @click="emit('cancel', run)">
            Abortar
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.rr { display: flex; flex-direction: column; gap: 0.4rem; }
.rr-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.rr-card {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border);
  border-left: 2px solid var(--accent);
  border-radius: var(--radius);
  background: var(--panel);
  min-width: 0;
}
.rr-head { display: flex; align-items: baseline; gap: 0.5rem; min-width: 0; }
.rr-head .live-dot { align-self: center; flex: 0 0 auto; }
.rr-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-body-sm);
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rr-elapsed {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--warn);
}
.rr-meta {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rr-actions { display: flex; gap: 0.4rem; }
</style>
