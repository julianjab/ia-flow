<script setup lang="ts">
import { onUnmounted, watch } from 'vue';

/**
 * El bottom sheet — el overlay de la capa táctil (T9, R6).
 *
 * Bajo `--bp-shell` un popover anclado a su disparador no sirve: en cuanto sube
 * el teclado virtual queda fuera de la pantalla, y anclado al borde derecho de
 * un input de 390px se dibuja mitad afuera. La respuesta del sistema es
 * siempre la misma pieza, con un solo timing, para que abrir los filtros, el
 * menú de `⋯` y un selector se sientan como el mismo gesto:
 *
 *   translateY en 150ms · backdrop al 60% que cierra al tocar · radio 12px arriba
 *
 * Es un contenedor y nada más: no sabe qué muestra. El contenido lo pone quien
 * lo abre, por el slot, y por eso vive en `ui/` — cero conocimiento de dominio.
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    /** Nombra el diálogo para lectores de pantalla. */
    title: string;
    /** Se dibuja arriba del contenido, en caja alta. Sin esto el sheet abre sin
     *  decir de qué es — el `aria-label` no lo ve nadie que mire la pantalla. */
    showTitle?: boolean;
  }>(),
  { showTitle: true },
);

const emit = defineEmits<{ close: [] }>();

/**
 * Escape cierra, y el fondo no scrollea mientras el sheet está abierto.
 *
 * Lo segundo no es cosmético: sin el bloqueo, el gesto de scrollear dentro del
 * sheet arrastra la página de atrás en cuanto la lista del sheet llega a su
 * tope, y el usuario pierde el lugar en el que estaba.
 */
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
    <div v-if="open" class="bs-backdrop" @click.self="emit('close')">
      <div class="bs" role="dialog" aria-modal="true" :aria-label="title">
        <div v-if="showTitle" class="bs__head">
          <span class="uc-label">{{ title }}</span>
          <button type="button" class="bs__close" aria-label="Cerrar" @click="emit('close')">✕</button>
        </div>
        <div class="bs__body">
          <slot />
        </div>
        <div v-if="$slots.footer" class="bs__foot">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.bs-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  z-index: 80;
  display: flex;
  align-items: flex-end;
}
.bs {
  width: 100%;
  max-height: 80vh;
  background: var(--panel);
  border-top: 1px solid var(--border-hi);
  border-radius: 12px 12px 0 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  animation: bs-in 150ms ease;
}
@keyframes bs-in {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
.bs__head {
  flex: 0 0 auto;
  height: var(--tap-h);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0.35rem 0 1rem;
  border-bottom: 1px solid var(--border);
}
.bs__close {
  width: var(--tap-h);
  height: var(--tap-h);
  border: none;
  background: none;
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  cursor: pointer;
}
.bs__close:hover { color: var(--fg); }
/* El cuerpo es lo único que scrollea: el título y el pie quedan quietos, que
   es lo que permite que el pie lleve la acción principal (R3). */
.bs__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0.5rem 0 0.75rem;
}
.bs__foot {
  flex: 0 0 auto;
  display: flex;
  gap: 0.5rem;
  padding: 0.6rem 1rem calc(0.6rem + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border);
}
.bs__foot > :deep(*) { flex: 1; min-height: var(--tap-h-lg); }

/* Sobre --bp-shell hay lugar para un diálogo centrado, que es lo que un mouse
   espera. La pieza es la misma; lo que cambia es de dónde entra. */
@media (min-width: 768px) {
  .bs-backdrop { align-items: center; justify-content: center; }
  .bs {
    width: min(30rem, 92vw);
    max-height: 78vh;
    border: 1px solid var(--border-hi);
    border-radius: var(--radius);
    animation: none;
  }
}
</style>
