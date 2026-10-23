<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import type { FeedSummary } from '@/features/inbox/queue/build';
import { useInboxStore } from '@/features/inbox/store';

// La celda «libres» abierta: QUÉ podría ocupar esos lugares —las primeras tarjetas listas del feed
// y cuántas más hay en «Qué le das al pipeline» (un ancla a esa sección)—. Sin feed (o sin
// ninguna lista), quién toma un lugar libre. Cada título abre la tarea en grande; el resto vive en
// «Próximo».

const SHOWN = 3;

const props = defineProps<{ feed: FeedSummary | null; anchor?: string }>();
const store = useInboxStore();
const ready = computed(() => (props.feed?.entries ?? []).filter((e) => !e.waitingOn));
const shown = computed(() => ready.value.slice(0, SHOWN));
const more = computed(() => ready.value.length - shown.value.length);
</script>

<template>
  <div class="fs" data-test="free-slots">
    <template v-if="shown.length">
      <p class="fs__lead">Lo podría ocupar:</p>
      <ul class="fs__list">
        <li v-for="e in shown" :key="e.ref" class="fs__row">
          <RefLink :short="e.short" :url="e.url" />
          <button type="button" class="fs__title" :title="e.title" :data-test="`free-open-${e.ref}`" @click="store.expand(e.ref)">
            {{ e.title }}
          </button>
        </li>
      </ul>
      <a v-if="more > 0 && anchor" class="fs__more link" :href="`#${anchor}`" data-test="free-more">
        y {{ more }} más en {{ feed?.title }}
      </a>
      <RouterLink v-else-if="more > 0" class="fs__more link" :to="{ name: 'next' }" data-test="free-more">
        y {{ more }} más en Próximo
      </RouterLink>
    </template>
    <p v-else class="fs__lead">Lo toma lo primero que pase a Refine o a Build; aprobar un PRD también lo ocupa.</p>
  </div>
</template>

<style scoped>
.fs { display: flex; flex-direction: column; gap: 0.15rem; padding-top: 0.5rem; }
.fs__lead { margin: 0; color: var(--fg-mute); font-size: var(--fs-chrome); line-height: 1.45; }
.fs__list { list-style: none; margin: 0; padding: 0; }
.fs__row { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
.fs__row :deep(.ref) { flex: none; }
.fs__title { flex: 1 1 auto; min-width: 0; min-height: var(--tap-h-sm); padding: 0; border: 0; background: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); font: inherit; font-size: var(--fs-body-sm); text-align: left; cursor: pointer; }
.fs__title:hover { color: var(--info); }
.fs__title:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
.fs__more { display: inline-flex; align-items: center; align-self: flex-start; min-height: var(--tap-h); font-size: var(--fs-chrome); }
</style>
