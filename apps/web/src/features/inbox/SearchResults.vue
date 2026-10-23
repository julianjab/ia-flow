<script setup lang="ts">
import { RouterLink } from 'vue-router';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import { refUrl, shortRef } from '@/features/inbox/queue/shortRef';
import { useInboxStore } from '@/features/inbox/store';

// Lo que coincide con el buscador, en lugar de la bandeja: cada card con dónde está (te necesita,
// corriendo, puede arrancar, su columna del board…). Tocarla la abre en grande, con sus acciones;
// el link corto va a GitHub. Si se escribió una ref exacta que no aparece, se ofrece abrirla igual
// y, al pie, la misma búsqueda en «Buscar en GitHub» (dentro de la app: lo que no está en el board
// se agrega desde ahí) para toda la organización.

const store = useInboxStore();
</script>

<template>
  <section class="sr" aria-labelledby="sr-h">
    <h2 id="sr-h" class="sr__hd">
      Resultados <span class="sr__n mono">{{ store.searchHits.length }}</span>
      <span v-if="store.restLoading" class="sr__dim">· buscando en el board…</span>
    </h2>

    <ul v-if="store.searchHits.length || store.searchExact" class="sr__list">
      <li v-for="hit in store.searchHits" :key="hit.ref" class="sr__item" data-test="hit">
        <button type="button" class="sr__row" :data-test="`hit-${hit.ref}`" @click="store.expand(hit.ref)">
          <span class="sr__title">{{ hit.title }}</span>
          <span class="sr__where">{{ hit.where }}<template v-if="hit.pr"> · PR #{{ hit.pr }}</template></span>
        </button>
        <RefLink :short="hit.short" :url="hit.url" />
      </li>
      <li v-if="store.searchExact" class="sr__item" data-test="exact">
        <button type="button" class="sr__row" @click="store.expand(store.searchExact)">
          <span class="sr__title">Abrir {{ shortRef(store.searchExact) }}</span>
          <span class="sr__where">no está en la bandeja ni en el board</span>
        </button>
        <RefLink
          v-if="refUrl(store.searchExact)"
          :short="shortRef(store.searchExact)"
          :url="refUrl(store.searchExact) ?? ''"
        />
      </li>
    </ul>
    <p v-else-if="!store.restLoading" class="sr__empty">
      Nada coincide con «{{ store.searchQuery.trim() }}» en la bandeja ni en el board.
    </p>

    <RouterLink
      v-if="store.searchQuery.trim()"
      class="sr__gh link"
      :to="{ name: 'github-search', query: { q: store.searchQuery.trim() } }"
      data-test="github"
    >
      Buscar «{{ store.searchQuery.trim() }}» en GitHub →
    </RouterLink>
  </section>
</template>

<style scoped>
.sr { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
.sr__hd { display: flex; align-items: baseline; gap: 0.4rem; margin: 0; font-size: var(--fs-body); }
.sr__n,
.sr__dim { color: var(--fg-dim); font-size: var(--fs-chrome); font-weight: 400; }
.sr__list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.sr__item { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0 0.5rem; padding-right: 0.75rem; }
.sr__item + .sr__item { border-top: 1px solid var(--border-mute); }
.sr__row {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
  min-height: var(--tap-h);
  padding: 0.55rem 0.75rem;
  border: 0;
  background: none;
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.sr__row:hover .sr__title { color: var(--accent); }
.sr__row:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.sr__title { overflow-wrap: anywhere; line-height: 1.35; }
.sr__where { color: var(--fg-dim); font-size: var(--fs-chrome); }
.sr__empty { margin: 0; padding: 0.75rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); color: var(--fg-mute); }
.sr__gh { display: inline-flex; align-items: center; align-self: flex-start; min-height: var(--tap-h); font-size: var(--fs-body-sm); }
</style>
