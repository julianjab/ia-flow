<script setup lang="ts">
import type { QueueFilter } from '@/features/inbox/queue/build';
import type { QueueRow } from '@/features/inbox/queue/entries';
import type { QueueType } from '@/features/inbox/queue/kinds';
import { useCollapsed } from '@/composables/useCollapsed';
import DecisionRow from '@/features/inbox/decisions/DecisionRow.vue';

// «Después»: el resto de las decisiones, numeradas en el orden de la cola (2, 3, …). Con más de
// FILTER_THRESHOLD decisiones aparece el filtro por tipo; filtrar no renumera.

defineProps<{ rows: QueueRow[]; total: number; filters: QueueFilter[] | null }>();
const emit = defineEmits<{ (e: 'filter', type: QueueType | null): void }>();

const keyOf = (row: QueueRow) => (row.kind === 'group' ? row.key : row.ref);
/** «Después» plegado: se recuerda en este navegador. */
const folded = useCollapsed('after');
</script>

<template>
  <section class="dq" aria-labelledby="after-h">
    <div class="dq__head">
      <h2 id="after-h" class="sec-hd">
        <button
          type="button"
          class="dq__fold"
          :aria-expanded="!folded"
          aria-controls="after-list"
          data-test="after-fold"
          @click="folded = !folded"
        >
          <span class="dq__chev" aria-hidden="true">{{ folded ? '▸' : '▾' }}</span>Después
        </button>
      </h2>
      <span class="uc-label">{{ total }} más</span>
    </div>

    <div v-if="filters && !folded" class="dq__filters" role="toolbar" aria-label="Filtrar por tipo">
      <button
        v-for="f in filters"
        :key="f.type ?? 'all'"
        type="button"
        class="filter-chip"
        :aria-pressed="f.pressed"
        :data-type="f.type ?? 'all'"
        @click="emit('filter', f.type)"
      >
        {{ f.label }} <span class="dq__n mono">{{ f.count }}</span>
      </button>
    </div>

    <div v-show="!folded" id="after-list" class="dq__list">
      <DecisionRow v-for="row in rows" :key="keyOf(row)" :row="row" />
    </div>
  </section>
</template>

<style scoped src="@/features/inbox/section.css" />
<style scoped>
/* Contenedor de las filas: «Después» vive en una columna (con el aside o el menú lateral), así que
   la fila cambia de forma según el ancho de la lista, no el de la ventana (DecisionRow). */
.dq { container: decisions / inline-size; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); min-width: 0; }
.dq__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.75rem; padding: 0.65rem 0.75rem; }
/* En una columna angosta los filtros son UNA fila que se desliza de costado (R2: la página no): en
   tres filas le comían media pantalla a la cola. Con lugar, vuelven a partirse en líneas. */
.dq__filters { display: flex; flex-wrap: nowrap; align-items: center; gap: 0.4rem; padding: 0.6rem 0.75rem; border-top: 1px solid var(--border-mute); overflow-x: auto; scrollbar-width: none; }
.dq__filters > * { flex: none; }
@container decisions (min-width: 36rem) {
  .dq__filters { flex-wrap: wrap; overflow-x: visible; }
}
.dq__n { color: var(--fg); font-weight: 700; }
.dq__fold { display: inline-flex; align-items: center; gap: 0.35rem; min-height: var(--tap-h-sm); padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.dq__chev { width: 0.8rem; color: var(--fg-dim); }
.dq__fold:focus:not(:focus-visible) { outline: none; }
@media (min-width: 640px) {
  .dq__head, .dq__filters { padding-left: 1rem; padding-right: 1rem; }
}
</style>
