<script setup lang="ts">
// El link corto a GitHub de toda referencia: «seller#4281 ↗», en una pestaña nueva. Es un
// blanco táctil (`--tap-h`) aunque se lea como texto mono.

defineProps<{ short: string; url: string; label?: string }>();
</script>

<template>
  <a
    class="ref link mono"
    :href="url"
    :title="short"
    target="_blank"
    rel="noopener noreferrer"
    :aria-label="label ?? `Abrir ${short} en GitHub`"
    >{{ short }} ↗</a
  >
</template>

<style scoped>
.ref {
  /* inline-block y no inline-flex: el ellipsis no se aplica al texto de un flex container. El
     alto táctil lo da el line-height. Una ref larga se recorta (el `title` la tiene entera) en vez
     de abrir un scroll horizontal en todo el documento. */
  display: inline-block;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
  line-height: var(--tap-h);
  font-size: var(--fs-micro);
  white-space: nowrap;
}
</style>
