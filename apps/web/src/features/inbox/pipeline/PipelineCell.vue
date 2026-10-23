<script setup lang="ts">
// Una celda de «El pipeline»: un número y su nombre. Con algo adentro es un `<button>` que abre
// su lista (aria-expanded/aria-controls); vacía es sólo un `<div>`, sin listener ni chevron.

defineProps<{ n: number | string; label: string; controls: string; expandable: boolean; open: boolean; free?: boolean }>();
const emit = defineEmits<{ (e: 'toggle'): void }>();
</script>

<template>
  <button
    v-if="expandable"
    type="button"
    class="pc__cell"
    :aria-expanded="open"
    :aria-controls="controls"
    @click="emit('toggle')"
  >
    <!-- El chevron va en la línea del número: pegado a la etiqueta, en 1100–1280 se partía solo. -->
    <span class="pc__top">
      <span class="pc__n mono" :class="{ 'pc__n--free': free }">{{ n }}</span>
      <span class="pc__chev" aria-hidden="true">{{ open ? '▴' : '▾' }}</span>
    </span>
    <span>{{ label }}</span>
  </button>
  <div v-else class="pc__cell">
    <span class="pc__n mono" :class="{ 'pc__n--free': free }">{{ n }}</span>
    <span>{{ label }}</span>
  </div>
</template>

<style scoped>
.pc__cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-height: var(--tap-h);
  padding: 0.45rem 0.55rem;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--panel-alt);
  color: var(--fg-dim);
  font-family: var(--font-body);
  font-size: var(--fs-chrome);
  text-align: left;
}
button.pc__cell { cursor: pointer; }
button.pc__cell:hover { background: var(--panel-hi); color: var(--fg); }
button.pc__cell:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
/* La celda abierta: el fondo del segmento elegido (v5), no un relleno de color. */
button.pc__cell[aria-expanded='true'] { background: var(--panel-top); color: var(--fg); }
.pc__cell[aria-expanded='true'] .pc__n { background: none; color: var(--fg); }
.pc__top { display: flex; align-items: baseline; justify-content: space-between; gap: 0.4rem; align-self: stretch; }
.pc__chev { flex: none; }
.pc__n { color: var(--fg); font-size: var(--fs-num); font-weight: 700; line-height: 1.35; font-variant-numeric: tabular-nums; }
.pc__n--free { color: var(--accent); }
</style>
