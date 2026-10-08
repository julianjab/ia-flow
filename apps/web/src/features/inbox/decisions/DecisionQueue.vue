<script setup lang="ts">
import { FILTER_THRESHOLD, type QueueFilter } from '@/features/inbox/queue/build';
import type { QueueRow } from '@/features/inbox/queue/entries';
import type { QueueType } from '@/features/inbox/queue/kinds';
import DecisionRow from '@/features/inbox/decisions/DecisionRow.vue';

// «Después»: el resto de las decisiones, numeradas en el orden de la cola (2, 3, …). Con más de
// FILTER_THRESHOLD decisiones aparece el filtro por tipo; filtrar no renumera.

defineProps<{ rows: QueueRow[]; total: number; filters: QueueFilter[] | null }>();
const emit = defineEmits<{ (e: 'filter', type: QueueType | null): void }>();

const keyOf = (row: QueueRow) => (row.kind === 'group' ? row.key : row.ref);
</script>

<template>
  <section class="dq" aria-labelledby="after-h">
    <div class="dq__head">
      <h2 id="after-h" class="sec-hd">Después</h2>
      <span class="uc-label">{{ total }} más</span>
    </div>

    <div v-if="filters" class="dq__filters" role="toolbar" aria-label="Filtrar por tipo">
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
      <span class="dq__hint">aparece con más de {{ FILTER_THRESHOLD }} decisiones</span>
    </div>

    <div class="dq__list">
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
.dq__filters { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; padding: 0.6rem 0.75rem; border-top: 1px solid var(--border-mute); }
.dq__n { color: var(--fg); font-weight: 700; }
.dq__hint { color: var(--fg-dimmer); font-size: var(--fs-micro); }
@media (min-width: 640px) {
  .dq__head, .dq__filters { padding-left: 1rem; padding-right: 1rem; }
}
</style>
