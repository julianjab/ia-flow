<script setup lang="ts">
import { computed } from 'vue';

// El esqueleto de una sección de la bandeja mientras llega SU dato: bloques `.skeleton` con la
// forma y el alto aproximado de lo que va a pintar (el titular, la card de «Lo primero», las filas
// de «Después», las celdas del pipeline, dos épicas, las filas del feed), para que el layout no
// salte. Con `label`, la sección es la que se anuncia: `aria-busy` y el texto para lectores de
// pantalla; sin él, es parte de otra que ya se anunció y queda oculta para ellos.

export type SkeletonShape = 'headline' | 'queue' | 'pipeline' | 'pipeline-line' | 'epics' | 'feed';

const props = withDefaults(defineProps<{ shape: SkeletonShape; label?: string; rows?: number }>(), { rows: 4 });
const announced = computed(() => Boolean(props.label));
/** Anchos de título que varían de fila en fila: una lista de bloques iguales no parece texto. */
const widths = ['78%', '62%', '70%', '55%', '66%'];
const rowList = computed(() => Array.from({ length: props.rows }, (_, i) => widths[i % widths.length]));
</script>

<template>
  <div
    class="sk"
    :class="`sk--${shape}`"
    :aria-busy="announced ? 'true' : undefined"
    :aria-hidden="announced ? undefined : 'true'"
    :data-test="`skeleton-${shape}`"
  >
    <span v-if="label" class="sr-only" role="status">{{ label }}</span>

    <template v-if="shape === 'headline'">
      <span class="skeleton sk__display" style="width: min(22rem, 70%)" />
      <span class="skeleton sk__meta" style="width: min(18rem, 50%)" />
    </template>

    <template v-else-if="shape === 'queue'">
      <div class="sk__first" aria-hidden="true">
        <span class="skeleton sk__kicker" />
        <div class="sk__main">
          <div class="sk__what">
            <span class="skeleton sk__verb" />
            <span class="skeleton" style="width: 85%" />
            <span class="skeleton" style="width: 60%" />
          </div>
          <span class="skeleton sk__btn" />
        </div>
        <div class="sk__chips"><span class="skeleton sk__chip" /><span class="skeleton sk__chip" /></div>
        <span class="skeleton sk__detail" />
      </div>
      <div class="sk__box" aria-hidden="true">
        <span class="skeleton sk__hd" />
        <div v-for="(w, i) in rowList" :key="i" class="sk__row">
          <span class="skeleton sk__rank" />
          <div class="sk__what">
            <span class="skeleton" style="width: 9rem" />
            <span class="skeleton" :style="{ width: w }" />
            <span class="skeleton sk__chip" />
          </div>
          <span class="skeleton sk__act" />
        </div>
      </div>
    </template>

    <div v-else-if="shape === 'pipeline'" class="sk__box sk__pad" aria-hidden="true">
      <span class="skeleton sk__hd" />
      <div class="sk__cells"><span v-for="i in 3" :key="i" class="skeleton sk__cell" /></div>
      <span class="skeleton sk__note" />
    </div>

    <div v-else-if="shape === 'pipeline-line' || shape === 'feed'" class="sk__box" aria-hidden="true">
      <div class="sk__line"><span class="skeleton sk__hd" /><span class="skeleton sk__meta" style="width: 8rem" /></div>
      <template v-if="shape === 'feed'">
        <div v-for="(w, i) in rowList" :key="i" class="sk__feed">
          <span class="skeleton sk__chip" /><span class="skeleton" :style="{ width: w }" />
        </div>
      </template>
    </div>

    <div v-else-if="shape === 'epics'" class="sk__box sk__pad" aria-hidden="true">
      <span class="skeleton sk__hd" />
      <div v-for="i in 2" :key="i" class="sk__epic">
        <span class="skeleton" :style="{ width: i === 1 ? '80%' : '65%' }" />
        <span class="skeleton sk__bar" />
        <span class="skeleton sk__meta" style="width: 10rem" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.sk { display: flex; flex-direction: column; gap: 0.9rem; min-width: 0; }
.sk--headline { gap: 0.35rem; }
.sk__display { height: 1.6rem; }
.sk__meta { height: 0.8rem; }
.sk__box { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); min-width: 0; }
.sk__pad { gap: 0.6rem; padding: 0.8rem 0.9rem; }
.sk__hd { width: 8rem; height: 0.9rem; }
.sk__box > .sk__hd { margin: 0.75rem; }
.sk__pad > .sk__hd { margin: 0; }
/* «Lo primero»: la misma caja (borde alto, padding) y los mismos renglones que FirstDecision. */
.sk__first { display: flex; flex-direction: column; gap: 0.6rem; padding: 0.9rem; border: 1px solid var(--border-hi); border-radius: var(--radius); background: var(--panel); }
.sk__kicker { width: 7rem; height: 0.8rem; }
.sk__main { display: flex; flex-direction: column; gap: 0.6rem; }
.sk__what { display: flex; flex: 1 1 auto; flex-direction: column; gap: 0.35rem; min-width: 0; }
.sk__verb { width: 13rem; max-width: 80%; height: var(--fs-num); }
.sk__btn { width: 100%; height: var(--tap-h-lg); }
.sk__chips { display: flex; gap: 0.5rem; }
.sk__chip { width: 5.5rem; flex: none; }
.sk__detail { height: 4.5rem; }
/* Una fila de «Después»: número, verbo, título, chip y el botón. */
.sk__row { display: grid; grid-template-columns: 1.4rem minmax(0, 1fr); gap: 0.5rem; padding: 0.7rem 0.75rem; border-top: 1px solid var(--border-mute); }
.sk__rank { width: 0.8rem; }
.sk__act { grid-column: 2; width: 7rem; height: var(--tap-h); }
.sk__cells { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.35rem; }
.sk__cell { height: 3.3rem; }
.sk__note { width: 85%; height: 0.7rem; }
.sk__line { display: flex; align-items: center; gap: 0.75rem; min-height: var(--tap-h); padding: 0 0.75rem; }
.sk__line .sk__hd { margin: 0; }
.sk__feed { display: flex; align-items: center; gap: 0.75rem; min-height: var(--tap-h); padding: 0 0.75rem; border-top: 1px solid var(--border-mute); }
.sk__epic { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.55rem 0; border-top: 1px solid var(--border-mute); }
.sk__bar { height: 0.3rem; }
@media (min-width: 640px) {
  .sk__first { padding: 1rem 1.1rem; }
  .sk__main { flex-direction: row; align-items: flex-start; }
  .sk__btn { width: 10rem; flex: none; }
  .sk__verb { height: var(--fs-display); }
  .sk__row { grid-template-columns: 1.4rem minmax(0, 1fr) auto; gap: 0.5rem 1rem; padding: 0.75rem 1rem; }
  .sk__act { grid-column: 3; grid-row: 1; }
  .sk__line, .sk__feed { padding-left: 1rem; }
}
</style>
