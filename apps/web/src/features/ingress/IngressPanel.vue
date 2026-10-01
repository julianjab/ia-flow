<script setup lang="ts">
import type { EventLogEntry, Ingress } from '@ia-flow/shared';
import { computed, onMounted, ref } from 'vue';
import EventRow from '@/components/EventRow.vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { formatRelative } from '@/composables/formatRelative';
import { getIngress, getIngressEvents } from '@/features/ingress/api';

// Por dónde le llegan eventos al runner y qué le llegó por cada una: el webhook
// de GitHub y Slack. Una tarjeta por entrada —si está configurada, el último,
// cuántos en 24 h— y, debajo, lo que llegó a la elegida, cada uno con lo que
// decidió cada pipeline. Lo que el runner rechazó antes (una firma mala) no está.

const ingress = ref<Ingress | null>(null);
const selected = ref<string | null>(null);
const events = ref<EventLogEntry[]>([]);
const loading = ref(false);
const loadingEvents = ref(false);
const error = ref<string | null>(null);

async function loadEvents(id: string) {
  selected.value = id;
  loadingEvents.value = true;
  try {
    events.value = await getIngressEvents(id);
    error.value = null;
  } catch (err) {
    error.value = extractErrorMessage(err);
  } finally {
    loadingEvents.value = false;
  }
}

async function load() {
  loading.value = true;
  try {
    ingress.value = await getIngress();
    error.value = null;
    // La elegida sigue elegida; si no hay, la primera que recibe algo.
    const first = ingress.value.sources.find((s) => s.count_kept > 0) ?? ingress.value.sources[0];
    const id = selected.value ?? first?.id;
    if (id) await loadEvents(id);
  } catch (err) {
    error.value = extractErrorMessage(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const current = computed(() => ingress.value?.sources.find((s) => s.id === selected.value));
</script>

<template>
  <div class="ig">
    <div class="ig__bar">
      <p class="ig__note">
        Lo que entra al runner, con lo que decidió cada pipeline<template v-if="ingress"> · se guardan {{ ingress.retention_days }} días</template>.
      </p>
      <button type="button" class="btn btn--ghost" :disabled="loading" @click="load">
        {{ loading ? 'leyendo…' : 'Actualizar' }}
      </button>
    </div>

    <div v-if="error" class="ig__err" role="alert">
      <p>✕ {{ error }}</p>
      <button type="button" class="btn" @click="load">Reintentar</button>
    </div>
    <p v-else-if="loading && !ingress" class="ig__note">· leyendo las entradas…</p>

    <div v-if="ingress" class="ig__sources" role="group" aria-label="Entradas">
      <button
        v-for="s in ingress.sources"
        :key="s.id"
        type="button"
        class="ig__src"
        :data-ok="s.configured"
        :aria-pressed="s.id === selected"
        :data-test="`source-${s.id}`"
        @click="loadEvents(s.id)"
      >
        <span class="ig__name">
          {{ s.name }}
          <span class="ig__kind mono">{{ s.kind === 'webhook' ? 'webhook' : 'socket' }}</span>
        </span>
        <span v-if="s.endpoint" class="ig__dim mono">POST {{ s.endpoint }}</span>
        <span v-if="s.configured" class="ig__state ig__state--ok">✓ configurada</span>
        <span v-else class="ig__state">sin configurar<template v-if="s.missing"> · falta <span class="mono">{{ s.missing }}</span></template></span>
        <span class="ig__stats">
          <span><b class="mono">{{ s.count_24h }}</b> en 24 h</span>
          <span><b class="mono">{{ s.count_kept }}</b> guardados</span>
          <span v-if="s.last_at">último {{ formatRelative(s.last_at) }}</span>
        </span>
      </button>
    </div>

    <section v-if="current" class="ig__events" :aria-label="`Lo que llegó por ${current.name}`">
      <h2 class="ig__hd">Lo que llegó por {{ current.name }}</h2>
      <p v-if="loadingEvents && !events.length" class="ig__note">· leyendo…</p>
      <p v-else-if="!events.length" class="ig__note">Todavía no llegó nada por acá.</p>
      <ul v-else class="ig__list">
        <li v-for="e in events" :key="e.id"><EventRow :event="e" show-task /></li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.ig { display: flex; flex-direction: column; gap: 1rem; }
.ig__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.75rem; min-height: var(--tap-h); }
.ig__note { flex: 1 1 14rem; margin: 0; color: var(--fg-dim); font-size: var(--fs-body-sm); }
.ig__err { display: flex; flex-direction: column; align-items: flex-start; gap: 0.35rem; padding: 0.75rem; border: 1px solid var(--danger); border-radius: var(--radius); background: var(--red-bg); }
.ig__err p { margin: 0; color: var(--danger); overflow-wrap: anywhere; }
/* Mobile primero: una entrada por fila; desde 640, en columnas. */
.ig__sources { display: grid; grid-template-columns: 1fr; gap: 0.6rem; }
.ig__src {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-height: var(--tap-h-lg);
  padding: 0.7rem 0.85rem;
  border: 1px solid var(--border);
  border-left: 3px solid var(--fg-dim);
  border-radius: var(--radius);
  background: var(--panel);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ig__src[data-ok='true'] { border-left-color: var(--accent); }
.ig__src:hover { background: var(--panel-alt); }
.ig__src[aria-pressed='true'] { border-color: var(--border-hi); background: var(--panel-alt); }
.ig__src:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.ig__name { display: flex; align-items: baseline; gap: 0.5rem; color: var(--fg); font-weight: 600; }
.ig__kind { color: var(--fg-dim); font-size: var(--fs-micro); font-weight: 400; }
.ig__dim { color: var(--fg-dim); font-size: var(--fs-chrome); overflow-wrap: anywhere; }
.ig__state { color: var(--warn); font-size: var(--fs-body-sm); }
.ig__state--ok { color: var(--accent); }
.ig__stats { display: flex; flex-wrap: wrap; gap: 0.2rem 1rem; color: var(--fg-mute); font-size: var(--fs-body-sm); }
.ig__stats b { color: var(--fg); font-weight: 500; }
.ig__events { display: flex; flex-direction: column; gap: 0.4rem; }
.ig__hd { margin: 0; font-size: var(--fs-body); text-transform: uppercase; letter-spacing: var(--tracking-hd); }
.ig__list { margin: 0; padding: 0 0.75rem; list-style: none; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.ig__list > li:first-child :deep(.er) { border-top: 0; }

@media (min-width: 640px) {
  .ig__sources { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
