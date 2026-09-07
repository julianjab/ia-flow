<script setup lang="ts">
import { computed, ref } from 'vue';
import { useIsMobile } from '@/composables/useIsMobile';
import BottomSheet from '@/ui/BottomSheet.vue';

/**
 * La segunda fila del chrome de una pantalla de lista (R12).
 *
 * El chrome de una lista son DOS filas y nada más: identidad —que la pone el
 * shell— y controles, que son estos. Antes acá había tres cosas apiladas: el
 * segmentado Lista/Board en su propia fila, el input de filtros en otra, y una
 * fila de chips con scroll horizontal (R2) en una tercera. 109px de alto para
 * elegir una vista y un filtro.
 *
 * Ahora es una fila de `--tap-h`:
 *
 *   [ Lista | Board ]  ————————  (filtro activo)  filtros ⌄
 *
 * El contenido de los filtros no lo conoce este componente: llega por el slot
 * por defecto, y lo único que decide acá es DÓNDE se dibuja.
 *
 * Bajo `--bp-shell` es un bottom sheet detrás de `filtros ⌄` (R6: un popover
 * anclado se va de la pantalla en cuanto sube el teclado), y lo que queda en la
 * fila es el **filtro activo** — la respuesta a "¿por qué no veo la tarea que
 * busco?", que es la pregunta que una lista filtrada tiene que poder contestar
 * sin abrir nada.
 *
 * Sobre el breakpoint el panel se dibuja inline y no hay `filtros ⌄` ni resumen:
 * el input de filtros ES el flujo de esa pantalla —se escribe seguido y sus
 * tokens ya dicen qué está puesto—, así que esconderlo tras un clic cambiaría
 * un problema de mobile por uno de escritorio, y duplicar el resumen al lado de
 * los tokens sería decir lo mismo dos veces.
 *
 * Vive en `components/` porque lo comparten tres features —tasks, statuses y
 * executions— y ninguna puede importar de otra.
 */
const props = withDefaults(
  defineProps<{
    /** Cuántos filtros hay puestos. `0` apaga el resaltado y el resumen. */
    filterCount?: number;
    /**
     * El filtro activo, dicho corto ("me toca 4", "status: en revisión").
     *
     * Es lo único de los filtros que se dibuja SIEMPRE, porque es la respuesta
     * a "¿por qué no veo la tarea que busco?" — la pregunta que una lista
     * filtrada tiene que poder contestar sin abrir nada.
     */
    summary?: string;
    /** Nombra el sheet. */
    title?: string;
  }>(),
  { filterCount: 0, title: 'Filtros' },
);

const emit = defineEmits<{ clear: [] }>();

const { isMobile } = useIsMobile();
const open = ref(false);

const hasFilters = computed(() => props.filterCount > 0);
</script>

<template>
  <div class="lcb">
    <div class="lcb__row">
      <slot name="view" />
      <span class="lcb__spacer" />

      <!-- Sin slot de filtros no hay `filtros ⌄`: un botón que abre un sheet
           vacío es peor que no ofrecerlo. Es el caso del board, que no filtra. -->
      <template v-if="isMobile && $slots.default">
        <!-- El resumen del filtro activo es un botón: tocarlo abre el mismo
             panel, así que no hace falta apuntarle al `⌄` de al lado. -->
        <button
          v-if="summary"
          type="button"
          class="lcb__active"
          :title="`${filterCount} filtro${filterCount === 1 ? '' : 's'} activo${filterCount === 1 ? '' : 's'}`"
          data-testid="list-controls-active"
          @click="open = true"
        >{{ summary }}</button>

        <button
          type="button"
          class="lcb__toggle"
          :class="{ 'lcb__toggle--on': hasFilters }"
          :aria-expanded="open"
          data-testid="list-controls-filters"
          @click="open = true"
        >
          filtros<span v-if="hasFilters" class="lcb__count">{{ filterCount }}</span>
          <span class="lcb__caret" aria-hidden="true">⌄</span>
        </button>
      </template>
    </div>

    <div v-if="!isMobile && $slots.default" class="lcb__panel">
      <slot />
    </div>

    <BottomSheet v-if="isMobile && $slots.default" :open="open" :title="title" @close="open = false">
      <div class="lcb__sheet-body">
        <slot />
      </div>
      <template #footer>
        <button type="button" class="btn" :disabled="!hasFilters" @click="emit('clear')">
          Limpiar
        </button>
        <button type="button" class="btn btn--primary" @click="open = false">
          Ver {{ filterCount ? 'filtrado' : 'todo' }}
        </button>
      </template>
    </BottomSheet>
  </div>
</template>

<style scoped>
.lcb { display: flex; flex-direction: column; }

.lcb__row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  /* Una fila de --tap-h, en cualquier ancho: todo lo que hay acá se toca. */
  min-height: var(--tap-h);
  border-bottom: 1px solid var(--border-mute);
}
.lcb__spacer { flex: 1 1 auto; }

/* --tap-h-sm y no --tap-h: son chips que van en fila y su destino es ancho.
   El del filtro activo NO es decorativo — navega al panel. */
.lcb__active,
.lcb__toggle {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  height: var(--tap-h-sm);
  padding: 0 0.7rem;
  border: 1px solid var(--border-hi);
  border-radius: var(--radius-sm);
  background: var(--panel-hi);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-chrome);
  white-space: nowrap;
  cursor: pointer;
}
.lcb__active {
  border-color: var(--accent);
  background: var(--green-bg);
  color: var(--accent);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-block;
  line-height: calc(var(--tap-h-sm) - 2px);
}
.lcb__toggle:hover { border-color: var(--accent); color: var(--accent); }
.lcb__toggle--on { border-color: var(--accent); color: var(--accent); }
.lcb__count {
  font-weight: 700;
  color: var(--accent);
}
.lcb__caret { color: var(--fg-dimmer); }

.lcb__panel {
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--border-mute);
}
.lcb__sheet-body { padding: 0 1rem; }
</style>
