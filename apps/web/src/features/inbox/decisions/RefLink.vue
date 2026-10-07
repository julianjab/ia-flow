<script setup lang="ts">
// El link corto a GitHub de toda referencia: «seller#4281 ↗», en una pestaña nueva. Es un
// blanco táctil (`--tap-h`) aunque se lea como texto mono.

defineProps<{ short: string; url: string; label?: string }>();
</script>

<template>
  <a class="ref mono" :href="url" target="_blank" rel="noopener noreferrer" :aria-label="label ?? `Abrir ${short} en GitHub`"
    >{{ short }} ↗</a
  >
</template>

<style scoped>
.ref {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap-h);
  color: var(--info);
  font-size: var(--fs-micro);
  white-space: nowrap;
}
/* `a:hover` global pinta el fondo: acá es un link de texto. */
.ref:hover { background: none; color: var(--info); text-decoration: underline; }
.ref:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
</style>
