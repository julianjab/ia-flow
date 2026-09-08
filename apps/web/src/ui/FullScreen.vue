<script setup lang="ts">
import { onUnmounted, watch } from 'vue';

/**
 * Un detalle o un formulario que ocupa la pantalla — la otra mitad de
 * `BottomSheet` (T9, A3, A5).
 *
 * La regla es del arquetipo, no de este componente: **bajo `--bp-shell` un
 * detalle es una pantalla con `←`, nunca un modal centrado**. Un diálogo de
 * 520px con `max-height: 90vh` en un teléfono de 390 es una pantalla con
 * bordes redondeados y 5% de backdrop inútil alrededor — pero que además
 * scrollea por dentro, así que el `Guardar` del pie queda a diez pantallas de
 * scroll DENTRO de una caja que ya no se ve entera.
 *
 * Sobre el breakpoint sigue siendo el diálogo centrado que un mouse espera.
 *
 * Lo que aporta y cada modal ya no tiene que escribir: el backdrop, el `Escape`,
 * el bloqueo del scroll de fondo, la caja, y el pie fijo — que abajo del
 * breakpoint **reemplaza a la tab bar** (R4) porque el detalle la tapa entera.
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    /** El backdrop cierra al tocar. Se apaga cuando hay cambios sin guardar:
     *  perder un formulario por un toque al costado es el peor default. */
    closeOnBackdrop?: boolean;
  }>(),
  { closeOnBackdrop: true },
);

const emit = defineEmits<{ close: [] }>();

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}

function setLock(on: boolean) {
  if (typeof document === 'undefined') return;
  document.body.style.overflow = on ? 'hidden' : '';
  if (on) document.addEventListener('keydown', onKeydown);
  else document.removeEventListener('keydown', onKeydown);
}

watch(() => props.open, setLock, { immediate: true });
onUnmounted(() => setLock(false));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fs-backdrop"
      @click.self="closeOnBackdrop ? emit('close') : undefined"
    >
      <div class="fs" role="dialog" aria-modal="true" :aria-label="title">
        <!-- `←` bajo --bp-shell, `✕` arriba: el mismo blanco, el glifo que
             corresponde al gesto. Volver de una pantalla y cerrar un diálogo
             no son lo mismo, aunque hagan lo mismo. -->
        <header class="fs__head">
          <button type="button" class="fs__back" aria-label="Cerrar" @click="emit('close')">
            <span class="fs__back-mobile" aria-hidden="true">←</span>
            <span class="fs__back-desktop" aria-hidden="true">✕</span>
          </button>
          <h2 class="fs__title">{{ title }}</h2>
          <div class="fs__head-extra"><slot name="header" /></div>
        </header>

        <div class="fs__body">
          <slot />
        </div>

        <!-- El pie no scrollea (R3). En un formulario largo el pie del
             documento está a varias pantallas, y `Guardar` ahí abajo no es "el
             último control": es un control que hay que ir a buscar. -->
        <footer v-if="$slots.footer" class="fs__foot">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Mobile primero (R8): la base es la pantalla completa, y el diálogo centrado
   se agrega con `min-width`. */
.fs-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: var(--bg);
  display: flex;
}
.fs {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.fs__head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  /* La misma altura que la barra de identidad del shell: es su reemplazo
     mientras el detalle está abierto (R12). */
  height: var(--tap-h);
  padding: 0 0.25rem;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.fs__back {
  flex: 0 0 auto;
  width: var(--tap-h);
  height: var(--tap-h);
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  cursor: pointer;
}
.fs__back:hover { color: var(--fg); }
.fs__back-desktop { display: none; }
.fs__title {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-display);
  font-size: var(--fs-body);
  letter-spacing: var(--tracking-hd);
  text-transform: uppercase;
  color: var(--fg);
}
.fs__head-extra { flex: 0 0 auto; display: flex; align-items: center; gap: 0.25rem; }

.fs__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.fs__foot {
  flex: 0 0 auto;
  display: flex;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem calc(0.6rem + env(safe-area-inset-bottom, 0px));
  background: var(--panel);
  border-top: 1px solid var(--border-hi);
}
/* A lo ancho y a --tap-h-lg: es la fila que el pulgar busca sin mirar, y no
   hay nada más compitiendo por ese espacio. */
.fs__foot > :deep(.btn) { flex: 1; min-height: var(--tap-h-lg); }

@media (min-width: 768px) {
  .fs-backdrop {
    background: rgba(0, 0, 0, 0.55);
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }
  .fs {
    flex: 0 1 auto;
    width: min(34rem, 100%);
    max-height: 85vh;
    border: 1px solid var(--border-hi);
    border-radius: var(--radius);
    background: var(--panel);
  }
  .fs__back-mobile { display: none; }
  .fs__back-desktop { display: inline; }
  .fs__body { padding: 1rem; }
  .fs__foot { justify-content: flex-end; }
  .fs__foot > :deep(.btn) { flex: 0 0 auto; }
}

/* Un formulario ancho (el editor de repo, con su ComboBox de paths) gana con
   más ancho sobre --bp-split, donde ya sobra. */
@media (min-width: 1100px) {
  .fs { width: min(44rem, 100%); }
}
</style>
