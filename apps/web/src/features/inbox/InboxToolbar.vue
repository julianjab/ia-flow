<script setup lang="ts">
import type { InboxProject } from '@ia-flow/shared';
import { computed } from 'vue';
import type { StreamState } from '@/features/inbox/stream';

// La segunda fila de la pantalla (R12): el filtro por proyecto —sólo si el
// runner tiene más de uno—, los links al Project y a su board en GitHub, y cómo
// está la conexión en vivo.

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

/** Los proyectos a la vista: el elegido, o todos. Con más de uno, cada link dice de cuál es. */
const linked = computed(() =>
  props.projects.filter((p) => p.url && (!props.project || p.id === props.project)),
);
</script>

<template>
  <div class="tb">
    <div v-if="projects.length > 1" class="tb__chips" role="group" aria-label="Proyecto">
      <button type="button" class="filter-chip" :aria-pressed="project === null" @click="emit('project', null)">
        Todos
      </button>
      <button
        v-for="p in projects"
        :key="p.id"
        type="button"
        class="filter-chip mono"
        :aria-pressed="project === p.id"
        @click="emit('project', p.id)"
      >
        {{ p.id }}
      </button>
    </div>

    <nav v-if="linked.length" class="tb__links" aria-label="En GitHub">
      <span v-for="p in linked" :key="p.id" class="tb__proj">
        <span v-if="projects.length > 1" class="tb__id mono">{{ p.id }}</span>
        <a :href="p.url" target="_blank" rel="noopener noreferrer" class="tb__link link">Proyecto ↗</a>
        <a v-if="p.board_url && p.board_url !== p.url" :href="p.board_url" target="_blank" rel="noopener noreferrer" class="tb__link link">
          Board ↗
        </a>
      </span>
    </nav>

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
.tb__links { display: flex; flex-wrap: wrap; gap: 0 1rem; }
.tb__proj { display: inline-flex; align-items: center; gap: 0 0.75rem; }
.tb__id { color: var(--fg-dim); font-size: var(--fs-chrome); }
/* `a:hover` global pinta el fondo: se redefine en el propio :hover. */
.tb__link { display: inline-flex; align-items: center; min-height: var(--tap-h); font-size: var(--fs-body-sm); }
.tb__live { display: flex; align-items: center; gap: 0.4rem; margin: 0 0 0 auto; color: var(--fg-dim); font-family: var(--font-mono); font-size: var(--fs-chrome); }
.tb__live[data-state='polling'],
.tb__live[data-state='reconnecting'] { color: var(--warn); }
</style>
