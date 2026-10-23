<script setup lang="ts">
import { SORT_MODES } from '@/features/inbox/queue/arrange';
import { useInboxStore } from '@/features/inbox/store';

// El orden de «Para mí»: el del runner (prioridad), el más reciente o el más viejo primero. Las
// fijadas van arriba con cualquiera. Se recuerda por runner (`state/arrange.ts`).

const store = useInboxStore();
</script>

<template>
  <div class="sc">
    <span id="sort-label" class="sc__label">Orden</span>
    <div class="seg" role="group" aria-labelledby="sort-label">
      <button
        v-for="m in SORT_MODES"
        :key="m.id"
        type="button"
        class="seg__btn"
        :aria-pressed="store.sort === m.id"
        :data-test="`sort-${m.id}`"
        @click="store.sort = m.id"
      >
        {{ m.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.sc { display: flex; align-items: center; gap: 0.6rem; min-width: 0; }
.sc__label { color: var(--fg-dim); font-size: var(--fs-chrome); }
.sc .seg { flex: 1; }
</style>
