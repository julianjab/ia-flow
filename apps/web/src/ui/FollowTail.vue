<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';

/**
 * Un stream que crece sin robarte el renglón que estás leyendo (T7, A2).
 *
 * El defecto principal del arquetipo "stream en vivo" no es el alto ni la
 * densidad: es que **llega un evento y perdés dónde estabas**. En una lista que
 * crece por ARRIBA —lo más nuevo primero, que es como se leen los logs de esta
 * app— cada entrada nueva empuja hacia abajo todo lo que estás mirando. No es
 * que se mueva un poco: con el socket activo, el renglón que ibas a leer se va
 * de la pantalla mientras lo leés.
 *
 * Este contenedor resuelve las dos mitades:
 *
 * 1. **Conserva tu posición visual.** Cuando llega contenido nuevo arriba y vos
 *    NO estás en el tope, se corrige el `scrollTop` por exactamente lo que
 *    creció la lista. El renglón que mirabas se queda donde estaba.
 * 2. **Te dice cuánto llegó.** Aparece `↑ N nuevos`, y tocarlo te lleva al
 *    tope. Volver arriba es un gesto tuyo, igual que reordenar.
 *
 * Estando EN el tope no hace nada: ahí seguir el stream es exactamente lo que
 * se quiere, y frenarlo sería el defecto simétrico.
 *
 * Lo comparten los cuatro streams (ejecuciones, logs del daemon, logs del
 * agent-host, runs abortados), que hoy resuelven esto por separado o no lo
 * resuelven.
 */
const props = withDefaults(
  defineProps<{
    /** Cuántos ítems hay ahora. Es lo que dispara la corrección: el contenedor
     *  no mira el DOM para adivinar si creció. */
    count: number;
    /** Debajo de esto, "estás en el tope". No es `=== 0` porque un scroll con
     *  inercia se queda en 2-3px y ahí frenar el follow sería un bug que sólo
     *  pasa a veces. */
    anchorThreshold?: number;
  }>(),
  { anchorThreshold: 8 },
);

const scroller = ref<HTMLElement | null>(null);
const atAnchor = ref(true);
/** Cuántos llegaron desde que te fuiste del tope. */
const pending = ref(0);
let lastCount = props.count;

function measure() {
  const el = scroller.value;
  if (!el) return;
  atAnchor.value = el.scrollTop <= props.anchorThreshold;
  if (atAnchor.value) pending.value = 0;
}

onMounted(measure);

/**
 * El alto se mide DENTRO del watcher, no en una variable que se va guardando.
 *
 * Un watcher de Vue corre **antes** de que el DOM se actualice (pre-flush), así
 * que `scrollHeight` acá es el alto de ANTES y después del `nextTick` es el de
 * después. Un `lastHeight` guardado de la vuelta anterior es una tercera copia
 * del estado que se desincroniza en cuanto algo cambia el alto sin cambiar el
 * conteo — una fila que se abre, una ventana que se angosta— y ahí la
 * corrección salta en vez de conservar la posición.
 */
watch(
  () => props.count,
  async (next) => {
    const grew = next - lastCount;
    lastCount = next;
    const el = scroller.value;
    // En el tope no se toca nada: seguir el stream es lo que se quiere ahí.
    if (!el || grew <= 0 || atAnchor.value) return;
    const before = el.scrollHeight;
    await nextTick();
    const after = el.scrollHeight;
    // La corrección: bajar el scroll por lo que creció ARRIBA deja el
    // contenido visible exactamente donde estaba.
    if (after > before) el.scrollTop += after - before;
    pending.value += grew;
  },
);

function goToTop() {
  const el = scroller.value;
  if (!el) return;
  el.scrollTo({ top: 0, behavior: 'smooth' });
  pending.value = 0;
  atAnchor.value = true;
}

const showPill = computed(() => !atAnchor.value && pending.value > 0);
</script>

<template>
  <div class="ft">
    <div ref="scroller" class="ft__scroller" @scroll.passive="measure">
      <slot />
    </div>

    <!-- Flota sobre el stream y no empuja: si ocupara alto, aparecer movería
         justamente el contenido que este componente existe para no mover. -->
    <button
      v-if="showPill"
      type="button"
      class="ft__pill"
      data-testid="follow-tail-pill"
      @click="goToTop"
    >
      ↑ {{ pending }} {{ pending === 1 ? 'nuevo' : 'nuevos' }}
    </button>
  </div>
</template>

<style scoped>
.ft { position: relative; display: flex; flex-direction: column; min-height: 0; }
.ft__scroller { flex: 1 1 auto; min-height: 0; overflow-y: auto; }

.ft__pill {
  position: absolute;
  top: 0.5rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3;
  display: inline-flex;
  align-items: center;
  /* Se toca: --tap-h-sm, la medida del chip que navega. */
  height: var(--tap-h-sm);
  padding: 0 0.9rem;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--panel-hi);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  cursor: pointer;
}
.ft__pill:hover { background: var(--panel-alt); }
</style>
