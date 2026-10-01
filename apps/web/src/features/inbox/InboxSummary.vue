<script setup lang="ts">
import type { InboxGroup } from '@ia-flow/shared';
import { GROUP_LABEL, GROUPS } from '@/features/inbox/labels';

// Los cuatro contadores de la bandeja, que además son los filtros. Un resumen
// nombra excepciones, no filas (R10): un grupo en cero no dibuja su número —y
// no se puede filtrar, no hay nada que ver—, salvo que ya sea el filtro activo
// (así se puede soltar).

defineProps<{
  counts: Record<Exclude<InboxGroup, 'idle'>, number>;
  active: InboxGroup | null;
}>();

const emit = defineEmits<{ (e: 'select', group: InboxGroup): void }>();
</script>

<template>
  <nav class="sum" aria-label="Filtrar por grupo">
    <button
      v-for="group in GROUPS"
      :key="group"
      type="button"
      class="sum__stat"
      :data-group="group"
      :aria-pressed="active === group"
      :disabled="counts[group] === 0 && active !== group"
      @click="emit('select', group)"
    >
      <span class="sum__label">{{ GROUP_LABEL[group] }}</span>
      <b v-if="counts[group] > 0" class="sum__n">{{ counts[group] }}</b>
    </button>
  </nav>
</template>

<style scoped>
.sum { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; }
@media (min-width: 640px) { .sum { grid-template-columns: repeat(4, 1fr); } }

.sum__stat {
  --c: var(--fg-dim);
  min-height: var(--tap-h);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  color: var(--fg);
  font-family: var(--font-body);
  text-align: left;
}
.sum__stat[data-group='need'] { --c: var(--warn); }
.sum__stat[data-group='fail'] { --c: var(--danger); }
.sum__stat[data-group='run'] { --c: var(--accent); }
.sum__stat[data-group='queue'] { --c: var(--fg-mute); }

.sum__label { color: var(--fg-mute); font-size: var(--fs-body-sm); font-weight: 500; }
.sum__n { color: var(--c); font: 600 1.2rem var(--font-mono); font-variant-numeric: tabular-nums; }
.sum__stat:hover:not(:disabled) { background: var(--panel-hi); }
.sum__stat:disabled { cursor: default; opacity: 0.6; }
/* Selección: video inverso, no outline de color (DESIGN_SYSTEM «Selección»). */
.sum__stat[aria-pressed='true'] { background: var(--accent); border-color: var(--accent); }
.sum__stat[aria-pressed='true'] .sum__label,
.sum__stat[aria-pressed='true'] .sum__n { color: var(--panel); }
.sum__stat:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
</style>
