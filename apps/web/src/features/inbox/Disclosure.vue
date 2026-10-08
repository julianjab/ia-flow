<script setup lang="ts">
// Un plegable de la bandeja: `<details>` con su línea de resumen —chevron que gira, el título y,
// al lado, lo que se ve plegado— a `--tap-h`, con foco visible. Lo usan el feed, el pipeline en
// una línea, el board de GitHub (y cada columna), la leyenda y el detalle técnico: una sola
// forma, no cinco copias.
//
// `tag`: `h2` para una sección de la pantalla, `h3` para una dentro de otra, `span` cuando el
// resumen no es un encabezado (el detalle técnico, una columna). `label`: el título en versalitas
// chicas (`uc-label`) en vez del de sección.
//
// El encabezado NO va dentro de `<summary>`: su rol implícito es de botón y VoiceOver aplana lo
// que tiene adentro, así que un h2 ahí desaparece de la navegación por encabezados. Va antes del
// `<details>`, sólo para lectores de pantalla; el título visible del resumen es un `<span>` (el
// nombre del botón). La caja (y la clase que pase quien lo usa) va en el envoltorio.

import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    title: string;
    tag?: 'h2' | 'h3' | 'span';
    label?: boolean;
    open?: boolean;
    /** Sin caja propia: vive dentro de otra (una columna del board). */
    bare?: boolean;
  }>(),
  { tag: 'h2', label: false, open: false, bare: false },
);
const heading = computed(() => props.tag !== 'span');
const emit = defineEmits<{ (e: 'toggle', open: boolean): void }>();
</script>

<template>
  <div class="dz" :class="{ 'dz--bare': bare }">
    <component :is="tag" v-if="heading" class="dz__sr">{{ title }}</component>
    <details class="dz__det" :open="open" @toggle="emit('toggle', ($event.target as HTMLDetailsElement).open)">
      <summary class="dz__sum">
        <span class="dz__chev" aria-hidden="true">▸</span>
        <span class="dz__title" :class="[label ? 'uc-label' : heading ? 'sec-hd' : 'dz__plain', { dz__hd: heading }]">{{ title }}</span>
        <slot name="meta" />
      </summary>
      <slot />
    </details>
  </div>
</template>

<style scoped src="@/features/inbox/section.css" />
<style scoped>
.dz { position: relative; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.dz--bare { border: 0; border-radius: 0; background: none; }
.dz__sum {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.15rem 0.75rem;
  min-height: var(--tap-h);
  padding: 0.35rem 0.75rem;
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
  cursor: pointer;
  list-style: none;
}
.dz--bare > .dz__det > .dz__sum { padding: 0; }
/* El encabezado para lectores de pantalla: fuera de la vista, no fuera del árbol. */
.dz__sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.dz__sum::-webkit-details-marker { display: none; }
.dz__sum:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.dz__chev { flex: none; margin-right: -0.4rem; color: var(--fg-dim); font-size: var(--fs-micro); transition: transform 120ms ease; }
.dz__det[open] > .dz__sum .dz__chev { transform: rotate(90deg); }
.dz__title { margin: 0; }
/* El título visible de un encabezado se ve como los h2 de la bandeja (700; display si es de sección). */
.dz__hd { font-weight: 700; }
.dz__hd.sec-hd { font-family: var(--font-display); }
@media (min-width: 640px) {
  .dz:not(.dz--bare) > .dz__det > .dz__sum { padding-left: 1rem; }
}
@media (prefers-reduced-motion: reduce) {
  .dz__chev { transition: none; }
}
</style>
