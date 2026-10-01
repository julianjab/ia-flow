<script setup lang="ts">
import { GROUP_LABEL, LEGEND, LEGEND_HIDDEN } from '@/features/inbox/labels';

// "Cómo se decide cada grupo": la respuesta a "¿por qué está esto acá?" sin salir
// de la pantalla. Plegada por defecto — se lee una vez, no en cada visita.
</script>

<template>
  <details class="lg">
    <summary class="lg__sum">Cómo se decide cada grupo</summary>
    <dl class="lg__body">
      <template v-for="entry in LEGEND" :key="entry.group">
        <dt class="lg__group" :data-group="entry.group">{{ GROUP_LABEL[entry.group] }}</dt>
        <dd class="lg__rules">
          <p v-for="rule in entry.rules" :key="rule">{{ rule }}</p>
          <p v-if="entry.order" class="lg__order">{{ entry.order }}</p>
        </dd>
      </template>
      <dt class="lg__group">No se muestra</dt>
      <dd class="lg__rules"><p>{{ LEGEND_HIDDEN }}</p></dd>
    </dl>
  </details>
</template>

<style scoped>
.lg { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.lg__sum { display: flex; align-items: center; min-height: var(--tap-h); padding: 0 0.75rem; color: var(--fg-mute); font-size: var(--fs-body-sm); cursor: pointer; }
.lg__body { margin: 0; padding: 0 0.75rem 0.5rem; display: grid; gap: 0; }
.lg__group { padding-top: 0.6rem; color: var(--fg-mute); font-weight: 600; font-size: var(--fs-body-sm); }
.lg__group[data-group='need'] { color: var(--warn); }
.lg__group[data-group='fail'] { color: var(--danger); }
.lg__group[data-group='run'] { color: var(--accent); }
.lg__rules { margin: 0; padding: 0.25rem 0 0.6rem; border-bottom: 1px solid var(--border-mute); color: var(--fg-mute); font-size: var(--fs-body-sm); line-height: 1.5; }
.lg__rules p { margin: 0 0 0.25rem; }
.lg__order { color: var(--fg-dim); }
/* R5: la etiqueta va arriba bajo 640; al lado desde ahí. */
@media (min-width: 640px) {
  .lg__body { grid-template-columns: 9rem 1fr; column-gap: 1rem; }
  .lg__group { border-bottom: 1px solid var(--border-mute); }
}
</style>
