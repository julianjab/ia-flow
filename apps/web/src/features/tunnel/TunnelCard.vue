<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useServerEvents } from '@/composables/useServerEvents';
import type { TunnelStatus } from '@/features/tunnel/api';
import { useTunnelStore } from '@/features/tunnel/store';
import { useToastStore } from '@/stores/toast';

// `secretConfigured` comes from the parent (it already loaded the env vars):
// without IA_FLOW_WEBHOOK_SECRET the endpoint answers 503, so a tunnel alone
// isn't enough and the card says so.
const props = defineProps<{ secretConfigured: boolean }>();

const tunnelStore = useTunnelStore();
const toastStore = useToastStore();

const status = computed(() => tunnelStore.current);
const isRunning = computed(() => status.value.state === 'running');
const isStarting = computed(() => status.value.state === 'starting');

const STATE_LABELS: Record<TunnelStatus['state'], string> = {
  stopped: 'cerrado',
  starting: 'abriendo…',
  running: 'abierto',
  error: 'error',
};

// The server pushes every transition, so the card follows a tunnel opened
// from another tab too.
useServerEvents((msg) => {
  if (msg.type === 'tunnel:status') tunnelStore.apply(msg as unknown as TunnelStatus);
});

// Fallback for the (rare) case where the WS message is missed while the
// tunnel is coming up — poll until it settles, then stop.
let pollTimer: ReturnType<typeof setInterval> | null = null;
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
// Navegar fuera de Entorno mientras el túnel arranca no debe dejar el interval
// pegándole a /api/tunnel sobre un componente ya desmontado.
onUnmounted(stopPolling);

function pollWhileStarting() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!isStarting.value) {
      stopPolling();
      return;
    }
    await tunnelStore.fetch();
  }, 2000);
}

async function onStart() {
  await tunnelStore.start();
  if (status.value.state === 'error') toastStore.error(status.value.error ?? 'No se pudo abrir el túnel');
  else pollWhileStarting();
}

async function onStop() {
  await tunnelStore.stop();
  toastStore.success('Túnel cerrado');
}

const copied = ref<string | null>(null);
async function copy(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    copied.value = label;
    setTimeout(() => { copied.value = null; }, 1500);
  } catch {
    toastStore.error('No se pudo copiar al portapapeles');
  }
}

// Modo efectivo del daemon. Se muestra acá porque la duda natural al ver la
// tarjeta es "¿ya está escuchando webhooks o sigue haciendo pull?".
const daemonProjects = computed(() => tunnelStore.webhook?.projects ?? []);
function daemonHint(p: (typeof daemonProjects.value)[number]): string {
  if (p.mode === 'polling') return 'pull en cada intervalo';
  if (!p.webhook) return 'sin manager activo';
  if (p.webhook.deliveryReceived) return 'recibiendo deliveries';
  return p.webhook.fallbackIntervalMs > 0
    ? 'sin deliveries todavía — sólo el scan de respaldo'
    : 'sin deliveries todavía — no hace pull, espera el webhook';
}

onMounted(() => {
  void tunnelStore.fetch().then(() => { if (isStarting.value) pollWhileStarting(); });
  void tunnelStore.fetchWebhookStatus();
});
</script>

<template>
  <div class="tunnel-card">
    <div class="tunnel-head">
      <div class="tunnel-title">
        <h3>Túnel de Cloudflare</h3>
        <span class="tunnel-badge" :class="`is-${status.state}`">{{ STATE_LABELS[status.state] }}</span>
      </div>
      <button
        v-if="!isRunning && !isStarting"
        type="button"
        class="save-button"
        :disabled="tunnelStore.busy || !status.installed"
        @click="onStart"
      >
        {{ tunnelStore.busy ? 'Abriendo…' : 'Abrir túnel' }}
      </button>
      <button v-else type="button" class="ghost-button" :disabled="tunnelStore.busy" @click="onStop">
        Cerrar túnel
      </button>
    </div>

    <p class="tunnel-desc">
      GitHub necesita una URL pública para entregar los webhooks. Esto levanta un túnel
      efímero (<code>cloudflared tunnel --url</code>) contra el puerto del API y te da la URL
      para pegar en el webhook del repo/organización.
    </p>

    <p v-if="!status.installed" class="tunnel-alert is-error">
      <code>cloudflared</code> no está instalado. Instalalo con <code>brew install cloudflared</code>.
    </p>

    <template v-if="isRunning">
      <div class="tunnel-field">
        <label>Webhook URL (Payload URL en GitHub)</label>
        <div class="tunnel-copy-row">
          <code class="tunnel-value">{{ status.webhookUrl }}</code>
          <button type="button" class="ghost-button" @click="copy(status.webhookUrl ?? '', 'webhook')">
            {{ copied === 'webhook' ? 'copiado' : 'copiar' }}
          </button>
        </div>
      </div>
      <div class="tunnel-field">
        <label>Base del túnel</label>
        <div class="tunnel-copy-row">
          <code class="tunnel-value is-dim">{{ status.url }}</code>
          <button type="button" class="ghost-button" @click="copy(status.url ?? '', 'base')">
            {{ copied === 'base' ? 'copiado' : 'copiar' }}
          </button>
        </div>
      </div>

      <p v-if="!props.secretConfigured" class="tunnel-alert is-warn">
        Falta <code>IA_FLOW_WEBHOOK_SECRET</code>: el endpoint responde <strong>503</strong> hasta
        que lo configures abajo. Usá el mismo valor en el campo <em>Secret</em> del webhook de GitHub.
      </p>
      <p v-else class="tunnel-alert is-ok">
        Configurá el webhook en GitHub con esa Payload URL, content type
        <code>application/json</code>, el secreto ya guardado y el evento
        <strong>Projects v2 item</strong>.
      </p>

      <p class="tunnel-alert is-ok">
        El túnel expone <strong>únicamente</strong> <code>POST /api/webhooks/github</code>
        (vía un proxy que responde 404 a todo lo demás). Aun así, cerralo cuando termines.
      </p>
    </template>

    <p v-if="status.state === 'error' && status.error" class="tunnel-alert is-error">
      {{ status.error }}
    </p>

    <div v-if="daemonProjects.length" class="tunnel-daemon">
      <label>Modo del daemon por proyecto</label>
      <div v-for="p in daemonProjects" :key="p.projectId" class="tunnel-daemon-row">
        <span class="tunnel-daemon-name">{{ p.name }}</span>
        <span class="tunnel-badge" :class="p.mode === 'webhook' ? 'is-running' : ''">{{ p.mode }}</span>
        <span class="tunnel-daemon-hint">{{ daemonHint(p) }}</span>
      </div>
    </div>

    <details v-if="status.recentLog.length" class="tunnel-log">
      <summary>Salida de cloudflared ({{ status.recentLog.length }} líneas)</summary>
      <pre>{{ status.recentLog.join('\n') }}</pre>
    </details>
  </div>
</template>

<style scoped>
.tunnel-card {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.85rem;
  margin-bottom: 1.25rem;
  border: 1px solid var(--border);
  background: var(--panel-alt);
}
.tunnel-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.tunnel-title { display: flex; align-items: center; gap: 0.5rem; }
.tunnel-title h3 { margin: 0; font-size: 0.9rem; font-weight: 600; }
.tunnel-badge {
  font-size: 0.68rem;
  padding: 0.1rem 0.4rem;
  background: var(--panel-hi);
  color: var(--fg-dim);
  font-weight: 500;
}
.tunnel-badge.is-running { background: var(--green-bg); color: var(--accent); }
.tunnel-badge.is-starting { background: var(--yellow-bg); color: var(--warn); }
.tunnel-badge.is-error { background: var(--red-bg); color: var(--danger); }
.tunnel-desc { margin: 0; font-size: 0.75rem; color: var(--fg-dim); line-height: 1.5; }
.tunnel-field { display: flex; flex-direction: column; gap: 0.25rem; }
.tunnel-field label {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: var(--tracking-lbl);
  color: var(--fg-dim);
}
.tunnel-copy-row { display: flex; align-items: center; gap: 0.5rem; }
.tunnel-value {
  flex: 1;
  padding: 0.3rem 0.5rem;
  background: var(--panel-hi);
  font-size: 0.78rem;
  color: var(--fg);
  overflow-x: auto;
  white-space: nowrap;
}
.tunnel-value.is-dim { color: var(--fg-dim); }
.tunnel-alert {
  margin: 0;
  padding: 0.4rem 0.55rem;
  font-size: 0.74rem;
  line-height: 1.5;
}
.tunnel-alert.is-warn { background: var(--yellow-bg); color: var(--warn); }
.tunnel-alert.is-error { background: var(--red-bg); color: var(--danger); }
.tunnel-alert.is-ok { background: var(--green-bg); color: var(--accent); }
.tunnel-alert code { font-size: 0.72rem; }
.ghost-button {
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--border-hi);
  background: transparent;
  color: var(--fg);
  font-size: 0.75rem;
  cursor: pointer;
}
.ghost-button:hover { border-color: var(--accent); color: var(--accent); }
.ghost-button:disabled { opacity: 0.6; cursor: not-allowed; }
.save-button {
  padding: 0.35rem 0.9rem;
  background: var(--accent);
  color: var(--panel);
  border: none;
  font-weight: 500;
  font-size: 0.8rem;
  cursor: pointer;
}
.save-button:disabled { opacity: 0.6; cursor: not-allowed; }
.tunnel-daemon { display: flex; flex-direction: column; gap: 0.2rem; }
.tunnel-daemon label {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: var(--tracking-lbl);
  color: var(--fg-dim);
}
.tunnel-daemon-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: var(--row-h);
  font-size: 0.75rem;
}
.tunnel-daemon-name { color: var(--fg); }
.tunnel-daemon-hint { color: var(--fg-dim); }
.tunnel-log { font-size: 0.72rem; color: var(--fg-dim); }
.tunnel-log pre {
  margin: 0.35rem 0 0;
  padding: 0.5rem;
  max-height: 180px;
  overflow: auto;
  background: var(--panel-hi);
  font-size: 0.7rem;
  white-space: pre-wrap;
}
</style>
