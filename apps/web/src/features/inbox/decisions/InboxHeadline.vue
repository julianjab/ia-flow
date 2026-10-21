<script setup lang="ts">
import type { Headline } from '@/features/inbox/queue/build';

// El titular: cuántas decisiones te esperan, cuántas tareas hay detrás y si algo falló. Es el
// resumen de la pantalla y no repite ningún número del pipeline (ni el de decisiones: las tareas
// sólo salen si un grupo junta varias).

defineProps<{ headline: Headline }>();
</script>

<template>
  <div class="hl" data-test="headline">
    <h2 class="hl__hd">
      {{ headline.decisions }} {{ headline.decisions === 1 ? 'decisión te espera' : 'decisiones te esperan' }}
    </h2>
    <span class="hl__sub">
      <!-- Las tareas sólo si son más que las decisiones (un grupo junta varias): «5 decisiones · 5 tareas» era ruido. -->
      <template v-if="headline.tasks !== headline.decisions">en {{ headline.tasks }} {{ headline.tasks === 1 ? 'tarea' : 'tareas' }} · </template><span class="hl__order">ordenadas por cuánto mueven el trabajo · </span>
      <span v-if="headline.failed > 0" class="hl__bad">✕ {{ headline.failed }} falló</span>
      <span v-else><span class="hl__ok">✓</span> nada falló</span>
    </span>
  </div>
</template>

<style scoped>
.hl { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.8rem; }
.hl__hd { margin: 0; font-size: var(--fs-display); line-height: 1.15; }
.hl__sub { color: var(--fg-dim); font-size: var(--fs-body-sm); }
.hl__ok { color: var(--accent); }
/* El porqué del orden no entra en un teléfono (el mockup móvil no lo lleva). */
.hl__order { display: none; }
@media (min-width: 640px) {
  .hl__order { display: inline; }
}
.hl__bad { color: var(--danger); }
</style>
