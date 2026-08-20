<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { getWebhookStatus, type WebhookProjectStatus, type WebhookStatus } from '@/features/webhook-status/api';

// El túnel público ya no lo gestiona ia-flow (ver README raíz / apps/server/CLAUDE.md,
// sección "Túnel"): se corre a mano fuera del proceso del server, apuntando a un proxy
// standalone (scripts/webhook-proxy.ts) que sólo expone POST /api/webhooks/github. Esta
// tarjeta se limita a mostrar el modo efectivo del daemon por proyecto.
const props = defineProps<{ secretConfigured: boolean }>();

const status = ref<WebhookStatus | null>(null);

const projects = computed(() => status.value?.projects ?? []);

function hint(p: WebhookProjectStatus): string {
  if (p.mode === 'polling') return 'pull en cada intervalo';
  if (!p.webhook) return 'sin manager activo';
  if (p.webhook.deliveryReceived) return 'recibiendo deliveries';
  return p.webhook.fallbackIntervalMs > 0
    ? 'sin deliveries todavía — sólo el scan de respaldo'
    : 'sin deliveries todavía — no hace pull, espera el webhook';
}

onMounted(async () => {
  try {
    status.value = await getWebhookStatus();
  } catch {
    status.value = null;
  }
});
</script>

<template>
  <div class="webhook-card">
    <h3>Webhooks de GitHub</h3>
    <p class="webhook-desc">
      GitHub necesita una URL pública para entregar los webhooks. ia-flow ya no abre ni
      administra un túnel — correlo vos aparte con <code>cloudflared tunnel --url</code>,
      <code>ngrok</code> o similar, apuntando a <code>scripts/webhook-proxy.ts</code> (expone
      únicamente <code>POST /api/webhooks/github</code>, nunca el puerto del API completo).
    </p>

    <p v-if="!props.secretConfigured" class="webhook-alert is-warn">
      Falta <code>IA_FLOW_WEBHOOK_SECRET</code>: el endpoint responde <strong>503</strong> hasta
      que lo configures abajo. Usá el mismo valor en el campo <em>Secret</em> del webhook de
      GitHub.
    </p>

    <div v-if="projects.length" class="webhook-daemon">
      <label>Modo del daemon por proyecto</label>
      <div v-for="p in projects" :key="p.projectId" class="webhook-daemon-row">
        <span class="webhook-daemon-name">{{ p.name }}</span>
        <span class="webhook-badge" :class="p.mode === 'webhook' ? 'is-running' : ''">{{ p.mode }}</span>
        <span class="webhook-daemon-hint">{{ hint(p) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.webhook-card {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.85rem;
  margin-bottom: 1.25rem;
  border: 1px solid var(--border);
  background: var(--panel-alt);
}
.webhook-card h3 { margin: 0; font-size: 0.9rem; font-weight: 600; }
.webhook-desc { margin: 0; font-size: 0.75rem; color: var(--fg-dim); line-height: 1.5; }
.webhook-alert {
  margin: 0;
  padding: 0.4rem 0.55rem;
  font-size: 0.74rem;
  line-height: 1.5;
  background: var(--yellow-bg);
  color: var(--warn);
}
.webhook-daemon { display: flex; flex-direction: column; gap: 0.2rem; }
.webhook-daemon label {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: var(--tracking-lbl);
  color: var(--fg-dim);
}
.webhook-daemon-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: var(--row-h);
  font-size: 0.75rem;
}
.webhook-daemon-name { color: var(--fg); }
.webhook-daemon-hint { color: var(--fg-dim); }
.webhook-badge {
  font-size: 0.68rem;
  padding: 0.1rem 0.4rem;
  background: var(--panel-hi);
  color: var(--fg-dim);
  font-weight: 500;
}
.webhook-badge.is-running { background: var(--green-bg); color: var(--accent); }
</style>
