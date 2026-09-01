<script setup lang="ts">
// Ícono de ayuda: reemplaza un párrafo siempre visible por un tooltip nativo
// que sólo aparece al pasar el mouse o enfocar con teclado. Mismo mecanismo
// que ya usa el resto de la app (`title=` en ActionsEditor,
// ConditionRowsEditor, EditableCard) — sin librería de tooltip nueva, sólo el
// glifo que lo hace descubrible.
defineProps<{ text: string }>()
</script>

<template>
  <span class="hint-ico" tabindex="0" role="note" :title="text" :aria-label="text">ⓘ</span>
</template>

<style scoped>
.hint-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--fg-dim);
  font-size: var(--fs-micro);
  cursor: help;
  line-height: 1;
}
.hint-ico:hover,
.hint-ico:focus-visible {
  color: var(--accent);
  outline: none;
}
</style>
