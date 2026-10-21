<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useBackClose } from '@/composables/useBackClose';

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
 * Se cierra como cualquier sheet del sistema: ✕, tocar afuera, Escape, el «atrás» del teléfono
 * (`useBackClose`) o arrastrándolo hacia abajo desde el asa, el título o el cuerpo ya en su tope.
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
     *  decir de qué es — el `aria-label` no lo ve nadie que mire la pantalla.
     *  Es un título y se escribe como tal: en minúscula normal, no en caja alta. */
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
useBackClose(() => props.open, () => emit('close'));

/**
 * Arrastrar para cerrar. El gesto arranca desde el asa o el título, o desde el cuerpo cuando ya
 * está scrolleado a su tope (si no, es el scroll de la lista). Se cierra al soltar pasado un
 * cuarto de su alto o con un tirón rápido; si no, vuelve a su lugar.
 */
const DRAG_START_PX = 8;
const FLING_PX_PER_MS = 0.6;
const body = ref<HTMLElement | null>(null);
const offset = ref(0);
const dragging = ref(false);
const leaving = ref(false);
let start: { y: number; t: number; can: boolean } | null = null;

function onTouchStart(e: TouchEvent) {
  const touch = e.touches[0];
  if (!touch || e.touches.length > 1 || window.matchMedia?.('(min-width: 768px)').matches) return;
  const inBody = body.value?.contains(e.target as Node) ?? false;
  start = { y: touch.clientY, t: e.timeStamp, can: !inBody || (body.value?.scrollTop ?? 0) <= 0 };
}

function onTouchMove(e: TouchEvent) {
  const touch = e.touches[0];
  if (!start || !touch || !start.can) return;
  const dy = touch.clientY - start.y;
  if (!dragging.value) {
    // Hacia arriba es scroll: el gesto ya no es de cierre.
    if (dy < 0) start.can = false;
    if (dy < DRAG_START_PX) return;
    dragging.value = true;
  }
  if (e.cancelable) e.preventDefault();
  offset.value = Math.max(0, dy - DRAG_START_PX);
}

function onTouchEnd(e: TouchEvent) {
  const s = start;
  start = null;
  if (!dragging.value || !s) return;
  dragging.value = false;
  const sheet = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect().height ?? 400;
  const speed = offset.value / Math.max(1, e.timeStamp - s.t);
  if (offset.value > sheet / 4 || speed > FLING_PX_PER_MS) {
    leaving.value = true;
    offset.value = sheet;
    setTimeout(() => emit('close'), 150);
  } else offset.value = 0;
}

// Cada apertura arranca en su lugar.
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    offset.value = 0;
    leaving.value = false;
  },
);

const dragStyle = computed(() =>
  offset.value || dragging.value
    ? { transform: `translateY(${offset.value}px)`, transition: dragging.value ? 'none' : undefined }
    : undefined,
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="bs-backdrop" @click.self="emit('close')">
      <div
        class="bs"
        :class="{ 'bs--settle': !dragging, 'bs--leaving': leaving }"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        :style="dragStyle"
        @touchstart="onTouchStart"
        @touchmove="onTouchMove"
        @touchend="onTouchEnd"
        @touchcancel="onTouchEnd"
      >
        <span class="bs__grab" aria-hidden="true" />
        <div v-if="showTitle" class="bs__head">
          <h2 class="bs__title">{{ title }}</h2>
          <button type="button" class="bs__close" aria-label="Cerrar" @click="emit('close')">✕</button>
        </div>
        <div ref="body" class="bs__body">
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
  background: var(--scrim);
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
/* Al soltar, vuelve a su lugar (o termina de bajar) con el mismo timing con el que entró. */
.bs--settle { transition: transform 150ms ease; }
.bs--leaving { pointer-events: none; }
/* El asa dice «esto se baja», y se baja: arrastrarla (o el título) cierra el sheet. El área que
   agarra el dedo es más alta que la raya (R1). */
.bs__grab { flex: none; align-self: stretch; height: 1rem; background: linear-gradient(var(--border-hi), var(--border-hi)) center 0.5rem / 2.25rem 0.25rem no-repeat; touch-action: none; }
.bs__head { touch-action: none; }
.bs__head {
  flex: 0 0 auto;
  min-height: var(--tap-h);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0 0.35rem 0 1rem;
}
.bs__title { margin: 0; color: var(--fg); font-size: var(--fs-num); font-weight: 600; text-wrap: balance; }
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
  padding: 0.25rem 0 calc(0.75rem + env(safe-area-inset-bottom, 0px));
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
  .bs__grab { display: none; }
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
