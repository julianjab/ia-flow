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
    <span class="pc__n mono" :class="{ 'pc__n--free': free }">{{ n }}</span>
    <span>{{ label }} {{ open ? '▴' : '▾' }}</span>
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
button.pc__cell:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
/* La celda abierta es la seleccionada: video inverso (DESIGN_SYSTEM «Selección»), no un contorno. */
button.pc__cell[aria-expanded='true'],
.pc__cell[aria-expanded='true'] .pc__n { background: var(--accent); color: var(--panel); }
.pc__n { color: var(--fg); font-size: var(--fs-num); font-weight: 700; line-height: 1.35; font-variant-numeric: tabular-nums; }
.pc__n--free { color: var(--accent); }
</style>
