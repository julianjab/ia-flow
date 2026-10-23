<script setup lang="ts">
import { computed, ref } from 'vue';
import { shownRepos } from '@/features/github-search/query';

// Dónde buscar: toda la organización o un repo. Son cientos, así que la lista se filtra: los del
// board primero (los de todos los días), después el resto por actividad. Enter elige el primero.

const props = defineProps<{
  org: string;
  board: readonly string[];
  repos: readonly string[];
  selected: string | null;
  loading: boolean;
}>();
const emit = defineEmits<{ select: [repo: string | null] }>();

const filter = ref('');
const shown = computed(() => shownRepos(props.board, props.repos, filter.value));

function first(): void {
  const name = shown.value.board[0] ?? shown.value.others[0];
  if (name) emit('select', name);
}
</script>

<template>
  <div class="rp" data-test="repo-picker">
    <input
      v-model="filter"
      class="rp__filter"
      type="search"
      :placeholder="`Filtrar ${repos.length ? `${repos.length} repos` : 'repos'}…`"
      aria-label="Filtrar repos"
      @keydown.enter.prevent="first"
    />
    <ul class="rp__list">
      <li>
        <button type="button" class="rp__row" :aria-pressed="selected === null" data-test="repo-all" @click="emit('select', null)">
          <span class="rp__name">Toda {{ org }}</span><span v-if="selected === null" class="rp__check" aria-hidden="true">✓</span>
        </button>
      </li>
      <li v-if="shown.board.length" class="rp__hd">En el board</li>
      <li v-for="name in shown.board" :key="`b:${name}`">
        <button type="button" class="rp__row" :aria-pressed="selected === name" :data-test="`repo-${name}`" @click="emit('select', name)">
          <span class="rp__name mono">{{ name }}</span><span v-if="selected === name" class="rp__check" aria-hidden="true">✓</span>
        </button>
      </li>
      <li v-if="shown.others.length" class="rp__hd">Todos, por actividad · {{ shown.others.length }}</li>
      <li v-for="name in shown.others" :key="`o:${name}`">
        <button type="button" class="rp__row" :aria-pressed="selected === name" :data-test="`repo-${name}`" @click="emit('select', name)">
          <span class="rp__name mono">{{ name }}</span><span v-if="selected === name" class="rp__check" aria-hidden="true">✓</span>
        </button>
      </li>
      <li v-if="!shown.others.length && loading" class="rp__hd">Cargando los repos de {{ org }}…</li>
    </ul>
  </div>
</template>

<style scoped>
.rp { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.5rem; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--panel); }
.rp__filter { min-height: var(--tap-h); font-size: var(--fs-input); }
.rp__list { list-style: none; margin: 0; padding: 0; max-height: 18rem; overflow-y: auto; }
.rp__hd { padding: 0.5rem 0.5rem 0.2rem; color: var(--fg-dim); font-size: var(--fs-chrome); }
.rp__row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  min-height: var(--tap-h);
  padding: 0 0.5rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.rp__row:hover { background: var(--panel-hi); }
.rp__row:focus-visible { outline: 2px solid var(--primary); outline-offset: -1px; }
.rp__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rp__check { color: var(--accent); }
</style>
