<script setup lang="ts">
// Runs abortados por stream-stall/overload upstream (UpstreamAbortError en
// packages/agent-engine/src/Agent.ts). El server ya reintenta solo con
// backoff hasta maxAttempts — esta pantalla es sólo lectura + "no esperes,
// reintenta ya" para el caso `exhausted` (o cualquiera que el operador no
// quiera esperar).
import { onMounted, onUnmounted, ref } from 'vue';
import axios from 'axios';
import { useToastStore } from '@/stores/toast';
import { type AgentAbortRecord, listAgentAborts, retryAgentAbort } from './agent-aborts-api';

const toastStore = useToastStore();

const aborts = ref<AgentAbortRecord[]>([]);
const loading = ref(false);
const retrying = ref<string | null>(null);

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
    aborts.value = await listAgentAborts();
  } catch (err) {
    toastStore.error(`No se pudieron cargar los runs abortados: ${extractError(err)}`);
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

function statusLabel(status: AgentAbortRecord['status']): string {
  return status === 'pending' ? 'reintentando' : 'agotado';
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('es');
}

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
        <h2>Runs abortados</h2>
        <p class="section-desc">
          Runs que un provider cortó por un stall/overload upstream
          (<code>UpstreamAbortError</code>). El server ya los reintenta solo con backoff hasta su
          tope de intentos — acá se ven los que siguen sin resolverse, y se puede forzar un
          reintento inmediato sin esperar el próximo barrido.
        </p>
      </div>
    </div>

    <p v-if="loading && !aborts.length" class="muted">Cargando…</p>

    <ul v-if="!loading && aborts.length" class="entry-list">
      <li v-for="abort in aborts" :key="abort.id" class="entry">
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
    <p v-else-if="!loading" class="muted">Sin runs abortados pendientes.</p>
  </section>
</template>

<style scoped>
.muted { color: var(--fg-dim); font-size: var(--fs-body-sm); }
.entry-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.entry {
  display: flex;
  gap: 0.75rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border);
  background: var(--panel-alt);
}
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
