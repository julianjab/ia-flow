<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

/**
 * Una fila que, deslizada a la izquierda con el dedo, muestra sus acciones debajo (como Mail o
 * mac-pulse). Es un atajo, no el único camino: quien la usa deja las mismas acciones a un toque
 * dentro de la fila (abrirla), porque el gesto no se descubre ni existe con mouse o teclado. Por
 * eso, cerrada, sus botones salen del orden de foco y del árbol de accesibilidad.
 *
 * - Sólo el dedo o el lápiz arrastran (`pointerType !== 'mouse'`); `touch-action: pan-y` deja el
 *   scroll vertical al navegador, que cancela el gesto si el dedo va hacia arriba o abajo.
 * - La dirección se decide una vez, a los 8 px: horizontal si |dx| > 1.2·|dy|.
 * - Se suelta pasada la mitad del ancho de las acciones: queda abierta; si no, vuelve.
 * - Abrir una cierra la que estaba abierta. Tocar una abierta (o recién deslizada) la cierra en
 *   vez de hacer lo que haría el toque.
 */
export interface SwipeAction {
  id: string;
  label: string;
  /** `primary` la pinta con el acento; `danger`, en rojo. */
  tone?: 'primary' | 'danger';
  disabled?: boolean;
}

const props = defineProps<{ actions: readonly SwipeAction[]; disabled?: boolean }>();
const emit = defineEmits<{ action: [id: string] }>();

const LOCK_PX = 8;
const ACTION_REM = 5.5;

const open = ref(false);
const dragX = ref<number | null>(null);
const acts = ref<HTMLElement | null>(null);
const me = Symbol('swipe-row');
let drag: { id: number; x0: number; y0: number; from: number; horiz: boolean | null } | null = null;
let swipedAt = 0;

const enabled = computed(() => !props.disabled && props.actions.length > 0);
const width = computed(() => `${props.actions.length * ACTION_REM}rem`);
const faceStyle = computed(() =>
  dragX.value === null ? undefined : { transform: `translateX(${dragX.value}px)`, transition: 'none' },
);

// La que está abierta, compartida entre todas las filas: abrir una cierra la otra.
watch(openRow, (id) => {
  if (id !== me) open.value = false;
});
watch(open, (now) => {
  if (now) {
    openRow.value = me;
    document.addEventListener('pointerdown', outside, true);
  } else {
    if (openRow.value === me) openRow.value = null;
    document.removeEventListener('pointerdown', outside, true);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside, true);
  if (openRow.value === me) openRow.value = null;
});

const root = ref<HTMLElement | null>(null);
function outside(e: PointerEvent) {
  if (!root.value?.contains(e.target as Node)) open.value = false;
}

function down(e: PointerEvent) {
  if (!enabled.value || e.pointerType === 'mouse' || !e.isPrimary) return;
  const w = acts.value?.offsetWidth ?? 0;
  drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, from: open.value ? -w : 0, horiz: null };
}

function move(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x0;
  const dy = e.clientY - drag.y0;
  if (drag.horiz === null && Math.hypot(dx, dy) > LOCK_PX) {
    drag.horiz = Math.abs(dx) > Math.abs(dy) * 1.2;
    if (drag.horiz) (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  if (drag.horiz === false) {
    drag = null;
    return;
  }
  if (!drag.horiz) return;
  const w = acts.value?.offsetWidth ?? 0;
  dragX.value = Math.max(-w, Math.min(0, drag.from + dx));
}

function up() {
  const was = drag;
  drag = null;
  if (!was?.horiz || dragX.value === null) {
    dragX.value = null;
    return;
  }
  const w = acts.value?.offsetWidth ?? 0;
  open.value = dragX.value < -w / 2;
  dragX.value = null;
  swipedAt = Date.now();
}

/** El toque que termina un deslizamiento, o el de una fila abierta, la cierra y nada más. */
function clickCapture(e: MouseEvent) {
  if (!open.value && Date.now() - swipedAt > 400) return;
  e.preventDefault();
  e.stopPropagation();
  open.value = false;
}

function press(a: SwipeAction) {
  open.value = false;
  emit('action', a.id);
}

defineExpose({ close: () => (open.value = false) });
</script>

<script lang="ts">
import { ref as sharedRef } from 'vue';

const openRow = sharedRef<symbol | null>(null);
</script>

<template>
  <div ref="root" class="sw" :class="{ 'sw--open': open, 'sw--on': enabled, 'sw--drag': dragX !== null }" :style="{ '--sw-w': width }">
    <div v-if="enabled" ref="acts" class="sw__acts" :aria-hidden="!open">
      <button
        v-for="a in actions"
        :key="a.id"
        type="button"
        class="sw__act"
        :data-tone="a.tone"
        :data-test="`swipe-${a.id}`"
        :disabled="a.disabled"
        :tabindex="open ? 0 : -1"
        @click="press(a)"
      >
        {{ a.label }}
      </button>
    </div>
    <div
      class="sw__face"
      :style="faceStyle"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="up"
      @click.capture="clickCapture"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
.sw { position: relative; min-width: 0; }
.sw--on { overflow: hidden; }
.sw__face { position: relative; z-index: 1; background: var(--panel); transition: transform 180ms ease; }
.sw--on .sw__face { touch-action: pan-y; }
.sw--open .sw__face { transform: translateX(calc(-1 * var(--sw-w))); }
.sw__acts { position: absolute; inset: 0 0 0 auto; display: flex; width: var(--sw-w); visibility: hidden; transition: visibility 0s 180ms; }
/* Cerrada no se ve ni un píxel de abajo: aparece al arrastrar y se va cuando la cara terminó de volver. */
.sw--open .sw__acts,
.sw--drag .sw__acts { visibility: visible; transition: none; }
.sw__act {
  flex: 1;
  min-width: 0;
  min-height: var(--tap-h);
  padding: 0 0.4rem;
  border: 0;
  border-left: 1px solid var(--border-mute);
  background: var(--panel-hi);
  color: var(--fg);
  font: inherit;
  font-size: var(--fs-chrome);
  font-weight: 500;
  line-height: 1.25;
  overflow-wrap: anywhere;
  cursor: pointer;
}
.sw__act[data-tone='primary'] { background: var(--accent); color: var(--bg); }
.sw__act[data-tone='danger'] { color: var(--danger); }
.sw__act:disabled { opacity: 0.5; cursor: default; }
.sw__act:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
@media (prefers-reduced-motion: reduce) {
  .sw__face { transition: none; }
}
</style>
