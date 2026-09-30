<script setup lang="ts">
import type { InboxProject } from '@ia-flow/shared';
import { computed } from 'vue';
import type { StreamState } from '@/features/inbox/stream';

// La segunda fila de la pantalla (R12): el filtro por proyecto —sólo si el
// runner tiene más de uno— y cómo está la conexión en vivo.

const props = defineProps<{
  projects: InboxProject[];
  project: string | null;
  stream: StreamState;
  loading: boolean;
}>();

const emit = defineEmits<{ (e: 'project', id: string | null): void; (e: 'refresh'): void }>();

const LIVE_COPY: Record<StreamState, string> = {
  connecting: 'conectando…',
  live: 'en vivo',
  reconnecting: 'reconectando…',
  polling: 'sin stream · se actualiza cada 30 s',
};
const liveCopy = computed(() => LIVE_COPY[props.stream]);
</script>

<template>
  <div class="tb">
    <div v-if="projects.length > 1" class="tb__chips" role="group" aria-label="Proyecto">
      <button type="button" class="tb__chip" :aria-pressed="project === null" @click="emit('project', null)">
        Todos
      </button>
      <button
        v-for="p in projects"
        :key="p.id"
        type="button"
        class="tb__chip mono"
        :aria-pressed="project === p.id"
        @click="emit('project', p.id)"
      >
        {{ p.id }}
      </button>
    </div>

    <p class="tb__live" :data-state="stream" role="status">
      <span v-if="stream === 'live'" class="live-dot" aria-hidden="true" />
      {{ liveCopy }}
    </p>
    <button type="button" class="btn btn--ghost" :disabled="loading" @click="emit('refresh')">
      {{ loading ? 'actualizando…' : 'Actualizar' }}
    </button>
  </div>
</template>

<style scoped>
.tb { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.75rem; min-height: var(--tap-h); }
.tb__chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }
/* Chip de filtro: `--tap-h-sm`, van varios en fila (DESIGN_SYSTEM «Grilla vs. blanco táctil»). */
.tb__chip {
  min-height: var(--tap-h-sm);
  padding: 0 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--fg-mute);
  font-size: var(--fs-body-sm);
}
.tb__chip:hover { background: var(--panel-hi); color: var(--fg); }
.tb__chip[aria-pressed='true'] { background: var(--accent); border-color: var(--accent); color: var(--panel); }
.tb__live { display: flex; align-items: center; gap: 0.4rem; margin: 0 0 0 auto; color: var(--fg-dim); font-family: var(--font-mono); font-size: var(--fs-chrome); }
.tb__live[data-state='polling'],
.tb__live[data-state='reconnecting'] { color: var(--warn); }
</style>
