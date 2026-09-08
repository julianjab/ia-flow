<script setup lang="ts">
import { useIsMobile } from '@/composables/useIsMobile';

/**
 * La barra de atajos al pie de una lista navegable.
 *
 * Sólo anuncia lo que `useKeyboardNav` realmente hace: `j`/`k` (o las flechas)
 * para moverse, `⏎` para abrir, `Esc` para cerrar. **No inventa atajos** — una
 * barra que ofrece `r reintentar` sobre una tecla que nadie bindeó es peor que
 * no tener barra: enseña un gesto que falla en silencio.
 *
 * Bajo `--bp-shell` no se renderiza, y es `v-if` y no `display: none` (T10): en
 * un teléfono no hay teclado que anunciar, y un nodo escondido igual ocupa el
 * DOM y lo lee un lector de pantalla.
 */
defineProps<{
  /** Se dibuja a la derecha: el escape de la pantalla ("ver las 42 tareas →"). */
  action?: { label: string };
}>();

const emit = defineEmits<{ action: [] }>();

const { isMobile } = useIsMobile();
</script>

<template>
  <div v-if="!isMobile" class="kbdbar">
    <span class="kbd">j/k</span>
    <span>navegar</span>
    <span class="kbd kbd--primary">⏎</span>
    <span>abrir</span>
    <span class="kbd">esc</span>
    <span>cerrar</span>
    <button v-if="action" type="button" class="kbdbar__action" @click="emit('action')">
      {{ action.label }} →
    </button>
  </div>
</template>

<style scoped>
.kbdbar {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  /* --row-h: es chrome que se LEE, no se toca. El único elemento tocable de la
     barra es el link de la derecha, que trae su propia área. */
  min-height: calc(var(--row-h) + 0.4rem);
  padding: 0 0.7rem;
  border-top: 1px solid var(--border);
  background: var(--panel);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dimmer);
}
.kbdbar__action {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  min-height: var(--tap-h);
  border: none;
  background: none;
  color: var(--info);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  cursor: pointer;
}
.kbdbar__action:hover { text-decoration: underline; }
</style>
