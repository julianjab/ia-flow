<script setup lang="ts">
// Runs recuperables — dos orígenes que el operador tiene que ver juntos
// porque los dos son "algo se cortó y necesita una mano":
//
//  - Aborts por stream-stall/overload upstream (UpstreamAbortError en
//    packages/agent-engine/src/Agent.ts). El server ya reintenta solo con
//    backoff hasta maxAttempts — acá se ve lo que sigue sin resolverse, con
//    su propio botón "Reintentar".
//  - Checkpoints resumibles que NO pasaron por ahí: un crash del server a
//    mitad de vuelta, o un run truncado por budget/iteraciones. La fila de
//    execution_logs quedó abierta esperando el próximo dispatch de esa
//    tarea, pero si nada la vuelve a disparar (la regla que la activó
//    escuchaba un evento que no se repite) se queda ahí para siempre sin que
//    se note — sólo aparecía como "en vuelo" indefinido en Ejecuciones. Acá
//    se hace visible, con un botón que re-emite el status de la tarea para
//    que las reglas la vuelvan a tomar (mismo mecanismo que "Correr ahora"
//    en Tareas).
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import axios from 'axios';
import { useToastStore } from '@/stores/toast';
import {
  type AgentAbortRecord,
  listRecoverableRuns,
  type RecoverableCheckpoint,
  retryAgentAbort,
  retryRecoverableCheckpoint,
} from './agent-aborts-api';

const route = useRoute();
const toastStore = useToastStore();

const aborts = ref<AgentAbortRecord[]>([]);
const checkpoints = ref<RecoverableCheckpoint[]>([]);
const loading = ref(false);
const retrying = ref<string | null>(null);

/** El `?run=` que deja el link "Resolver" de Ejecuciones (verdict.ts) —
 *  resalta la fila que trajo al operador acá, sea abort o checkpoint. */
const highlightRunId = computed(() => {
  const v = route.query.run;
  return typeof v === 'string' ? v : null;
});

function extractError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string } | undefined;
    return data?.error ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

async function load() {
  loading.value = true;
  try {
    const result = await listRecoverableRuns();
    aborts.value = result.aborts;
    checkpoints.value = result.checkpoints;
  } catch (err) {
    toastStore.error(`No se pudieron cargar los runs recuperables: ${extractError(err)}`);
  } finally {
    loading.value = false;
  }
}

async function retry(record: AgentAbortRecord) {
  retrying.value = record.id;
  try {
    await retryAgentAbort(record.id);
    toastStore.success(`Reintento forzado para la tarea '${record.taskId}'`);
    await load();
  } catch (err) {
    toastStore.error(`No se pudo reintentar: ${extractError(err)}`);
  } finally {
    retrying.value = null;
  }
}

async function retryCheckpoint(cp: RecoverableCheckpoint) {
  if (!cp.projectId) return;
  retrying.value = cp.runId;
  try {
    await retryRecoverableCheckpoint(cp.taskId, cp.projectId);
    toastStore.success(`Se re-emitió el status de '${cp.taskId}' — las reglas la vuelven a evaluar`);
    await load();
  } catch (err) {
    toastStore.error(`No se pudo destrabar: ${extractError(err)}`);
  } finally {
    retrying.value = null;
  }
}

function statusLabel(status: AgentAbortRecord['status']): string {
  return status === 'pending' ? 'reintentando' : 'agotado';
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es');
}

/** El eje que sí importa acá: hace cuánto quedó colgado, no la fecha exacta. */
function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return formatDate(iso);
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `hace ${mins}min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `hace ${hours}h`;
  return `hace ${Math.round(hours / 24)}d`;
}

const empty = computed(
  () => !loading.value && aborts.value.length === 0 && checkpoints.value.length === 0,
);

// El barrido automático puede resolver o agregar filas sin que el operador
// haga nada — un polling liviano mantiene la lista al día sin necesitar un
// canal de WS dedicado para algo tan poco frecuente.
const POLL_INTERVAL_MS = 30_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void load();
  pollTimer = setInterval(() => { void load(); }, POLL_INTERVAL_MS);
});
onUnmounted(() => {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});
</script>

<template>
  <section class="settings-section">
    <div class="section-header">
      <div class="section-head-text">
        <h2>Runs recuperables</h2>
        <p class="section-desc">
          Runs que se cortaron y todavía se pueden retomar: abortados por un stall/overload
          upstream (<code>UpstreamAbortError</code>, con reintento automático), y runs con un
          checkpoint resumible que quedaron esperando un nuevo dispatch — un crash del server a
          mitad de vuelta, o un truncado por presupuesto/iteraciones.
        </p>
      </div>
    </div>

    <p v-if="loading && empty" class="muted">Cargando…</p>

    <template v-if="!empty">
      <div v-if="aborts.length" class="entry-group">
        <h3 class="entry-group__title">Reintentando automáticamente ({{ aborts.length }})</h3>
        <ul class="entry-list">
          <li
            v-for="abort in aborts"
            :key="abort.id"
            class="entry"
            :class="{ 'entry--highlight': abort.runId === highlightRunId }"
          >
            <div class="entry-main">
              <div class="entry-head">
                <span class="entry-id">{{ abort.taskId }}</span>
                <span class="entry-agent">{{ abort.agentId }}</span>
                <span class="entry-status" :class="`status-${abort.status}`">
                  {{ statusLabel(abort.status) }}
                </span>
                <span class="entry-attempts">{{ abort.attempts }}/{{ abort.maxAttempts }} intentos</span>
              </div>
              <p class="entry-reason">{{ abort.reason }}</p>
              <p v-if="abort.errorMsg" class="entry-error">{{ abort.errorMsg }}</p>
              <span class="entry-meta">
                actualizado {{ formatDate(abort.updatedAt) }}
                <template v-if="abort.nextRetryAt">
                  · próximo reintento {{ formatDate(abort.nextRetryAt) }}
                </template>
              </span>
            </div>
            <div class="entry-actions">
              <button
                type="button"
                class="btn btn--primary"
                :disabled="retrying === abort.id"
                @click="retry(abort)"
              >
                {{ retrying === abort.id ? 'Reintentando…' : 'Reintentar' }}
              </button>
            </div>
          </li>
        </ul>
      </div>

      <div v-if="checkpoints.length" class="entry-group">
        <h3 class="entry-group__title">Checkpoints recuperables ({{ checkpoints.length }})</h3>
        <ul class="entry-list">
          <li
            v-for="cp in checkpoints"
            :key="cp.runId"
            class="entry"
            :class="{ 'entry--highlight': cp.runId === highlightRunId }"
          >
            <div class="entry-main">
              <div class="entry-head">
                <span class="entry-id">{{ cp.taskTitle ?? cp.taskId }}</span>
                <span v-if="cp.agentId" class="entry-agent">{{ cp.agentId }}</span>
                <span class="entry-status" :class="cp.resumable ? 'status-pending' : 'status-exhausted'">
                  {{ cp.resumable ? 'resumible' : 'no resumible' }}
                </span>
                <span class="entry-attempts">{{ cp.attempts }}/10 reanudaciones</span>
              </div>
              <p class="entry-reason">
                {{ cp.stillOpen ? 'Quedó en vuelo, esperando el próximo dispatch' : 'La fila del run ya cerró' }}
              </p>
              <p v-if="!cp.resumable" class="entry-error">
                Pasó el tope de edad o de reanudaciones — el próximo dispatch va a arrancar de
                cero en vez de continuar.
              </p>
              <span class="entry-meta">actualizado {{ formatAge(cp.updatedAt) }}</span>
            </div>
            <div class="entry-actions">
              <button
                type="button"
                class="btn btn--primary"
                :disabled="retrying === cp.runId || !cp.projectId"
                :title="cp.projectId ? undefined : 'Sin projectId — no se puede re-despachar'"
                @click="retryCheckpoint(cp)"
              >
                {{ retrying === cp.runId ? 'Destrabando…' : 'Reintentar ahora' }}
              </button>
            </div>
          </li>
        </ul>
      </div>
    </template>

    <p v-if="empty && !loading" class="muted">Sin runs recuperables pendientes.</p>
  </section>
</template>

<style scoped>
.muted { color: var(--fg-dim); font-size: var(--fs-body-sm); }
.entry-group { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 1rem; }
.entry-group__title {
  margin: 0;
  font-size: var(--fs-body-sm);
  font-weight: 600;
  color: var(--fg-mute);
  text-transform: uppercase;
  letter-spacing: var(--tracking-hd);
}
.entry-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.entry {
  display: flex;
  gap: 0.75rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border);
  background: var(--panel-alt);
}
.entry--highlight { border-color: var(--info); }
.entry-main { flex: 1; display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
.entry-head { display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap; }
.entry-id { font-family: var(--font-mono); font-weight: 600; color: var(--info); }
.entry-agent { font-family: var(--font-mono); font-size: var(--fs-body-sm); color: var(--fg); }
.entry-status {
  font-size: var(--fs-micro);
  border: 1px solid currentColor;
  padding: 0 0.3rem;
  line-height: var(--row-h);
}
.status-pending { color: var(--warn); }
.status-exhausted { color: var(--danger); }
.entry-attempts { font-size: var(--fs-micro); color: var(--fg-dim); font-family: var(--font-mono); }
.entry-reason { margin: 0; font-size: var(--fs-body-sm); color: var(--fg-mute); }
.entry-error {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--danger);
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.entry-meta { font-size: var(--fs-micro); color: var(--fg-dim); }
.entry-actions { display: flex; flex-direction: column; justify-content: center; }
</style>
