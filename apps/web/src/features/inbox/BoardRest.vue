<script setup lang="ts">
import { computed, watch } from 'vue';
import ActionError from '@/features/inbox/decisions/ActionError.vue';
import AgeStamp from '@/features/inbox/decisions/AgeStamp.vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import Disclosure from '@/features/inbox/Disclosure.vue';
import { loadFailure } from '@/features/inbox/queue/advice';
import { ageOf } from '@/features/inbox/queue/age';
import { shortRef } from '@/features/inbox/queue/shortRef';
import { useInboxStore } from '@/features/inbox/store';

// «Board de GitHub»: lo que la bandeja no muestra, las cards sin pendientes (Backlog, Todo, lo
// que terminó…). Arranca plegado, pero se pide al montar (y al cambiar de proyecto) para que la
// línea de resumen ya diga la cuenta por columna. Abierto, cada columna es otra línea plegada;
// en cada fila, el botón abre la tarea en grande y el link corto va a GitHub.

const store = useInboxStore();

watch(
  () => store.project,
  () => void store.loadRest(),
  { immediate: true },
);

const columns = computed(() =>
  (store.rest?.columns ?? [])
    .map((column) => ({ status: column.status, items: column.items }))
    .filter((column) => column.items.length > 0),
);
const total = computed(() => columns.value.reduce((n, c) => n + c.items.length, 0));
const failure = computed(() => (store.restError ? loadFailure('leer el board', store.restError) : null));
</script>

<template>
  <Disclosure title="Board de GitHub" class="br">
    <template #meta>
      <span v-if="store.rest" class="br__dim">
        {{ total }} {{ total === 1 ? 'card' : 'cards' }}<template v-for="c in columns" :key="c.status"> · {{ c.status }} {{ c.items.length }}</template>
      </span>
      <span v-else class="br__dim">lo que no necesita nada: Backlog, Todo, lo terminado…</span>
    </template>

    <div class="br__body">
      <ActionError v-if="failure" :failure="failure" :busy="store.restLoading" @retry="store.loadRest()" />
      <p v-else-if="store.restLoading && !store.rest" class="br__dim">· leyendo el board…</p>

      <template v-if="store.rest">
        <p v-if="!columns.length" class="br__dim">Nada más en el board.</p>

        <Disclosure v-for="c in columns" :key="c.status" :title="c.status" tag="span" bare class="br__col">
          <template #meta><span class="br__n mono">{{ c.items.length }}</span></template>
          <ul class="br__list">
            <li v-for="item in c.items" :key="item.ref" class="br__item">
              <button type="button" class="br__row" :data-test="`rest-${item.ref}`" @click="store.expand(item.ref)">
                <span class="br__title">{{ item.title }}</span>
                <span class="br__meta mono">
                  <template v-if="item.pr">PR #{{ item.pr.number }} · </template><AgeStamp :age="ageOf(item.updated_at, store.now)" />
                </span>
              </button>
              <RefLink :short="shortRef(item.ref)" :url="item.url" />
            </li>
          </ul>
        </Disclosure>
      </template>
    </div>
  </Disclosure>
</template>

<style scoped>
.br__dim { color: var(--fg-dim); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.br__body { display: flex; flex-direction: column; gap: 0.5rem; padding: 0 0.75rem 0.75rem; }
.br__body > p { margin: 0; }
.br__col { border-top: 1px solid var(--border-mute); }
.br__n { color: var(--fg-dim); font-size: var(--fs-chrome); }
.br__list { display: flex; flex-direction: column; margin: 0; padding: 0 0 0.5rem 1.4rem; list-style: none; }
/* El botón abre el detalle; el link, GitHub. Un <a> no puede ir dentro de un <button>. */
.br__item { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0 0.5rem; }
/* Una fila densa (R11): se lee a `--row-h`, se toca entera a `--tap-h`. */
.br__row {
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
  min-width: 0;
  min-height: var(--tap-h);
  padding: 0.3rem 0.4rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.br__row:hover { background: var(--panel-alt); }
.br__row:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.br__title { color: var(--fg-mute); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.br__meta { color: var(--fg-dim); font-size: var(--fs-micro); font-variant-numeric: tabular-nums; }
</style>
