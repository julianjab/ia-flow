<script setup lang="ts">
import type { ImprovementProposal } from '@ia-flow/shared';
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { formatRelative } from '@/composables/formatRelative';
import type { DecisionState } from './store';
import { TARGETS } from './targets';

// Una mejora en la lista: el título y, debajo, dónde se arregla, en qué repo y hace cuánto. Tocarla
// lleva a su pantalla (el porqué, el issue, la columna y las acciones). Corta, como una fila de la
// bandeja: la card entera sólo en su pantalla.

const props = defineProps<{ proposal: ImprovementProposal; state?: DecisionState }>();

const repo = computed(() => props.proposal.repo.split('/').pop() ?? props.proposal.repo);
const done = computed(() => props.state?.status === 'done');
</script>

<template>
  <RouterLink :to="{ name: 'improvement', params: { id: proposal.id } }" class="ir" :data-done="done || undefined" data-test="improvement-row">
    <span class="ir__what">
      <span class="ir__title">{{ proposal.title }}</span>
      <span class="ir__meta">
        {{ TARGETS[proposal.target] }} · <span class="mono">{{ repo }}</span> · {{ formatRelative(proposal.created_at) }}
      </span>
    </span>
    <span v-if="done" class="ir__done">✓ Abierta</span>
    <span class="ir__chev" aria-hidden="true">›</span>
  </RouterLink>
</template>

<style scoped>
.ir { display: flex; align-items: center; gap: 0.75rem; width: 100%; min-height: calc(var(--tap-h) + 0.6rem); padding: 0.55rem 0.9rem; border: 0; border-top: 1px solid var(--border-mute); background: none; color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
.ir:first-child { border-top: 0; }
.ir:hover { background: var(--panel-hi); color: var(--fg); text-decoration: none; }
.ir:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.ir__what { display: flex; flex: 1; flex-direction: column; gap: 0.15rem; min-width: 0; }
.ir__title { font-weight: 600; display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
.ir__meta { color: var(--fg-dim); font-size: var(--fs-chrome); }
.ir__done { flex: none; color: var(--accent); font-size: var(--fs-chrome); font-weight: 600; }
.ir__chev { flex: none; color: var(--fg-dim); }
</style>
