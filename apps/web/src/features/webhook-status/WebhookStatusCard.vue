<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { formatRelative } from '@/composables/formatRelative';
import {
  getWebhookStatus,
  type WebhookProjectStatus,
  type WebhookStatus,
} from '@/features/webhook-status/api';

// Qué modo tiene el daemon de cada proyecto: ¿ya escucha webhooks o sigue
// haciendo pull? El túnel público no lo administra ia-flow: se corre aparte
// apuntando al proxy standalone (scripts/webhook-proxy.ts), que sólo expone
// `POST /api/webhooks/github`.

const status = ref<WebhookStatus | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);

const projects = computed(() => status.value?.projects ?? []);

function hint(p: WebhookProjectStatus): string {
  if (p.mode === 'polling') return 'pull en cada intervalo';
  if (!p.webhook) return 'sin manager activo';
  if (p.webhook.deliveryReceived) {
    return p.webhook.lastEventAt
      ? `recibiendo deliveries · último ${formatRelative(p.webhook.lastEventAt)}`
      : 'recibiendo deliveries';
  }
  return p.webhook.fallbackIntervalMs > 0
    ? 'sin deliveries todavía — sólo el scan de respaldo'
    : 'sin deliveries todavía — no hace pull, espera el webhook';
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    status.value = await getWebhookStatus();
  } catch (err) {
    error.value = extractErrorMessage(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="settings-section wh">
    <div class="section-header">
      <div class="section-head-text">
        <h2>Webhooks de GitHub</h2>
        <p class="section-desc">
          GitHub necesita una URL pública para entregar los webhooks. ia-flow no abre ni administra un
          túnel: corrélo aparte (<code>cloudflared tunnel --url</code>, <code>ngrok</code>…)
          apuntando a <code>scripts/webhook-proxy.ts</code>, que expone únicamente
          <code>POST /api/webhooks/github</code>.
        </p>
      </div>
      <div class="section-head-actions">
        <button type="button" class="btn" :disabled="loading" @click="load">
          {{ loading ? 'actualizando…' : 'Actualizar' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="wh__err" role="alert">
      <p>✕ {{ error }}</p>
      <p class="wh__next">→ Revisá que el runner esté corriendo y responda en /api/webhooks/status.</p>
    </div>

    <template v-else-if="status">
      <p v-if="!status.secretConfigured" class="wh__warn">
        Falta <code>IA_FLOW_WEBHOOK_SECRET</code>: el endpoint responde <strong>503</strong> hasta que
        lo configures. Usá el mismo valor en el campo <em>Secret</em> del webhook de GitHub.
      </p>

      <p class="wh__endpoint">
        <span class="uc-label">endpoint</span>
        <code>{{ status.endpoint }}</code>
      </p>

      <ul v-if="projects.length" class="wh__list">
        <li v-for="p in projects" :key="p.projectId" class="wh__row">
          <span class="wh__name">{{ p.name }}</span>
          <span class="wh__mode" :class="{ 'wh__mode--on': p.mode === 'webhook' }">{{ p.mode }}</span>
          <span class="wh__hint">{{ hint(p) }}</span>
        </li>
      </ul>
      <p v-else class="wh__hint">· sin proyectos</p>
    </template>

    <p v-else class="wh__hint">· cargando…</p>
  </section>
</template>

<style scoped>
.wh { display: flex; flex-direction: column; gap: 0.75rem; }
.wh p { margin: 0; }
.wh__err p { color: var(--danger); overflow-wrap: anywhere; }
.wh__err .wh__next { color: var(--info); font-size: var(--fs-body-sm); }
.wh__warn { padding: 0.5rem 0.75rem; border-radius: var(--radius); background: var(--yellow-bg); color: var(--warn); font-size: var(--fs-body-sm); line-height: 1.5; }
.wh__endpoint { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem; overflow-wrap: anywhere; }
.wh__list { list-style: none; margin: 0; padding: 0; }
/* R5: etiqueta arriba bajo 640; en fila desde ahí. */
.wh__row { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.5rem 0; border-top: 1px solid var(--border-mute); }
.wh__name { color: var(--fg); font-weight: 500; }
.wh__hint { color: var(--fg-dim); font-size: var(--fs-body-sm); }
/* Chip: una caja; el estado lo da el color (DESIGN_SYSTEM «Chip / tag»). */
.wh__mode { align-self: flex-start; line-height: var(--row-h); padding: 0 0.4rem; border: 1px solid var(--border); border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-dim); }
.wh__mode--on { color: var(--accent); border-color: var(--accent); background: var(--green-bg); }
@media (min-width: 640px) {
  .wh__row { flex-direction: row; align-items: baseline; gap: 0.75rem; }
  .wh__name { min-width: 10rem; }
}
</style>
