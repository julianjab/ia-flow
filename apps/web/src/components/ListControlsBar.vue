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
 * por defecto, y lo único que decide acá es DÓNDE se dibuja. Lo mismo hace el
 * slot `tools` con los controles que dan forma a la lista (el orden, el
 * contador, actualizar): en la fila cuando hay ancho, y dentro del sheet
 * cuando no. Sin eso, Tareas metía seis controles en una fila de 390px y la
 * pantalla terminaba con 199px de scroll horizontal (R2) — que además deja la
 * tab bar fija apuntando a un ancho que ya no es el de la pantalla.
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
/**
 * Un atajo de filtro rápido: un toque prende (o apaga, si ya estaba puesto)
 * un recorte que el dueño de la lista define — una disposición, un bucket,
 * lo que sea. Este componente no sabe qué significa `key`; sólo lo dibuja y
 * lo devuelve al tocarlo.
 */
export interface QuickFilter {
  key: string;
  label: string;
  count: number;
  glyph?: string;
  /** El único con color propio es el que pide algo tuyo (R... mismo criterio
   *  que ya usaban Tareas y Ejecuciones antes de compartir este componente). */
  tone?: 'danger';
}

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
    /**
     * Los chips de un toque, arriba del filtro — no adentro de un sheet ni
     * lejos de `FilterQueryInput`/`TaskFiltersBar`: el gesto es "tocar y ya
     * está filtrado", y el lugar de un atajo de filtro es al lado de donde se
     * filtra a mano. Cualquier pantalla de lista puede definir los suyos; el
     * componente no interpreta `key`, sólo lo emite.
     */
    quickFilters?: QuickFilter[];
    /** Qué `key` de `quickFilters` está activo ahora mismo. */
    activeQuickFilter?: string | null;
  }>(),
  { filterCount: 0, title: 'Filtros' },
);

const emit = defineEmits<{ clear: []; quickFilter: [key: string] }>();

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
      <!-- Los controles de forma sólo entran en la fila cuando hay ancho. -->
      <slot v-if="!isMobile" name="tools" />

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

    <!-- Atajos de un toque, arriba del filtro y en cualquier ancho: no se
         esconden detrás de `filtros ⌄` porque contestan "¿qué me toca?" sin
         que haga falta abrir nada. Un `quickFilters` vacío (la lista no
         definió ninguno, o los suyos dieron cero — R10) no dibuja nada. -->
    <div v-if="quickFilters && quickFilters.length" class="lcb__quick" aria-label="Filtros rápidos">
      <button
        v-for="qf in quickFilters"
        :key="qf.key"
        type="button"
        class="lcb__quick-chip"
        :class="[qf.tone ? `lcb__quick-chip--${qf.tone}` : null, { 'lcb__quick-chip--on': activeQuickFilter === qf.key }]"
        :aria-pressed="activeQuickFilter === qf.key"
        :data-testid="`quick-filter-${qf.key}`"
        :title="activeQuickFilter === qf.key ? `Quitar el filtro ${qf.label}` : `Filtrar por ${qf.label}`"
        @click="emit('quickFilter', qf.key)"
      >
        <span v-if="qf.glyph" class="lcb__quick-chip-glyph" aria-hidden="true">{{ qf.glyph }}</span>
        {{ qf.label }}
        <b>{{ qf.count }}</b>
      </button>
    </div>

    <div v-if="!isMobile && $slots.default" class="lcb__panel">
      <slot />
    </div>

    <BottomSheet v-if="isMobile && $slots.default" :open="open" :title="title" @close="open = false">
      <div class="lcb__sheet-body">
        <div v-if="$slots.tools" class="lcb__sheet-tools"><slot name="tools" /></div>
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
  min-width: 0;
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
/* Éste SÍ se achica: es texto variable ("status: en revisión · repo: x"), y con
   `0 0 auto` empujaba a `filtros ⌄` fuera de la pantalla en vez de truncarse. */
.lcb__active {
  flex: 0 1 auto;
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

/* Chips de filtro rápido, no barras a todo el ancho: cada uno mide su
   contenido, no `flex: 1` — son un atajo, no un encabezado de columnas. */
.lcb__quick {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  padding: 0.6rem 0 0;
}
.lcb__quick-chip {
  /* Se toca (prende su filtro): --tap-h-sm, la medida del chip que navega. */
  height: var(--tap-h-sm);
  display: inline-flex;
  align-items: center;
  gap: 0.35ch;
  padding: 0 0.7rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--panel);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-chrome);
  white-space: nowrap;
  cursor: pointer;
}
.lcb__quick-chip:hover { border-color: var(--border-hi); }
/* El único con color propio es el que pide algo tuyo. */
.lcb__quick-chip--danger { border-color: var(--danger); background: var(--red-bg); color: var(--danger); }
/* El activo, en video inverso — la misma marca que toda selección del sistema. */
.lcb__quick-chip--on { background: var(--accent); border-color: var(--accent); color: var(--panel); }
.lcb__quick-chip--on b { color: var(--panel); }
.lcb__quick-chip-glyph { color: var(--fg-dim); }
.lcb__quick-chip--on .lcb__quick-chip-glyph { color: var(--panel); }

.lcb__panel {
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--border-mute);
}
.lcb__sheet-body { padding: 0 1rem; }
/* Adentro de un sheet, un popover anclado no tiene a qué anclarse: la lista de
   sugerencias ES el contenido, así que va EN FLUJO y sin alto propio — el que
   scrollea es el cuerpo del sheet, que llega hasta 80vh.
   Como popover medía 278px dentro de un cuerpo de 63 y sus doce opciones
   quedaban las doce fuera de la parte visible: el sheet se dibujaba de 178px
   sobre una pantalla de 844 y parecía vacío. Es R6 al revés — bajo el
   breakpoint el overlay se vuelve sheet, y adentro del sheet no hay overlays. */
.lcb__sheet-body :deep(.fq-menu) {
  position: static;
  max-height: none;
  margin-top: 0.35rem;
  box-shadow: none;
}
/* Los controles de forma, arriba de los filtros y separados: son otra cosa
   —cómo se ordena la lista— y mezclarlos con los campos del filtro haría
   pensar que también filtran. */
.lcb__sheet-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding-bottom: 0.6rem;
  margin-bottom: 0.6rem;
  border-bottom: 1px solid var(--border-mute);
}
</style>
