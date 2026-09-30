<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { formatRelative } from '@/composables/formatRelative';
import { useInboxStore } from '@/features/inbox/store';

// Lo que la bandeja no muestra: las cards sin pendientes (Backlog, Todo, lo que
// terminó…). Arranca plegado y se pide al runner recién al abrirlo: la bandeja no
// carga con el board entero. Abierto, cada columna es otra línea plegada con su
// conteo; una fila abre la tarea en grande.

const store = useInboxStore();

const open = ref(false);

watch(
  [open, () => store.project],
  ([isOpen]) => {
    if (isOpen) void store.loadRest();
  },
);

const columns = computed(() =>
  (store.rest?.columns ?? [])
    .map((column) => ({
      status: column.status,
      items: column.items,
    }))
    .filter((column) => column.items.length > 0),
);
const total = computed(() => columns.value.reduce((n, c) => n + c.items.length, 0));
</script>

<template>
  <details class="br" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary class="br__head">
      <span class="br__chev" aria-hidden="true">▸</span>
      <span class="uc-label">Resto del board</span>
      <span v-if="store.rest" class="br__dim">
        {{ total }} {{ total === 1 ? 'card' : 'cards' }} ·
        <template v-for="(c, i) in columns" :key="c.status">{{ i ? ' · ' : '' }}{{ c.status }} {{ c.items.length }}</template>
      </span>
      <span v-else class="br__dim">lo que no necesita nada: Backlog, Todo, lo terminado…</span>
    </summary>

    <div class="br__body">
      <p v-if="store.restError" class="br__err" role="alert">✕ {{ store.restError }}</p>
      <p v-else-if="store.restLoading && !store.rest" class="br__dim">· leyendo el board…</p>

      <template v-if="store.rest">
        <p v-if="!columns.length" class="br__dim">Nada más en el board.</p>

        <details v-for="c in columns" :key="c.status" class="br__col">
          <summary class="br__colhead">
            <span class="br__chev" aria-hidden="true">▸</span>
            <span class="mono">{{ c.status }}</span>
            <span class="br__n mono">{{ c.items.length }}</span>
          </summary>
          <ul class="br__list">
            <li v-for="item in c.items" :key="item.ref">
              <button type="button" class="br__row" :data-test="`rest-${item.ref}`" @click="store.expand(item.ref)">
                <span class="br__ref mono">{{ item.ref }}</span>
                <span v-if="item.pr" class="br__dim mono">PR #{{ item.pr.number }}</span>
                <span class="br__age mono">{{ formatRelative(item.updated_at) }}</span>
                <span class="br__title">{{ item.title }}</span>
              </button>
            </li>
          </ul>
        </details>
      </template>
    </div>
  </details>
</template>

<style scoped>
.br { border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.br__head,
.br__colhead { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.6rem; min-height: var(--tap-h); padding: 0 0.75rem; cursor: pointer; list-style: none; }
.br__head::-webkit-details-marker,
.br__colhead::-webkit-details-marker { display: none; }
.br__head:focus-visible,
.br__colhead:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.br__chev { flex: none; color: var(--fg-dim); font-size: var(--fs-micro); transition: transform 120ms ease; }
.br[open] > .br__head .br__chev,
.br__col[open] > .br__colhead .br__chev { transform: rotate(90deg); }
.br__dim { color: var(--fg-dim); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.br__err { margin: 0; color: var(--danger); font-size: var(--fs-body-sm); }
.br__body { display: flex; flex-direction: column; gap: 0.5rem; padding: 0 0.75rem 0.75rem; }
.br__body > p { margin: 0; }
/* Chip de filtro (`--tap-h-sm`), como los de proyecto. */
.br__col { border-top: 1px solid var(--border-mute); }
.br__colhead { padding: 0; font-size: var(--fs-body-sm); }
.br__n { color: var(--fg-dim); font-size: var(--fs-chrome); }
.br__list { display: flex; flex-direction: column; margin: 0; padding: 0 0 0.5rem 1.4rem; list-style: none; }
/* Una fila densa (R11): se lee a `--row-h`, se toca entera a `--tap-h`. */
.br__row {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 0 0.6rem;
  align-items: baseline;
  width: 100%;
  min-height: var(--tap-h);
  padding: 0.3rem 0.4rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}
.br__row:hover { background: var(--panel-alt); }
.br__row:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.br__ref { color: var(--fg); font-size: var(--fs-chrome); }
.br__age { justify-self: end; color: var(--fg-dim); font-size: var(--fs-chrome); white-space: nowrap; }
.br__title { grid-column: 1 / -1; color: var(--fg-mute); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
</style>
