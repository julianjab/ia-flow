<script setup lang="ts">
import { computed } from 'vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import type { FeedSummary } from '@/features/inbox/queue/build';

// La celda «libres» abierta: QUÉ podría ocupar esos lugares —las primeras tarjetas listas del feed
// y cuántas más hay en «Qué le das al pipeline» (un ancla a esa sección)—. Sin feed (o sin
// ninguna lista), quién toma un lugar libre.

const SHOWN = 3;

const props = defineProps<{ feed: FeedSummary | null; anchor?: string }>();
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
          <span class="fs__title" :title="e.title">{{ e.title }}</span>
        </li>
      </ul>
      <a v-if="more > 0 && anchor" class="fs__more" :href="`#${anchor}`" data-test="free-more">
        y {{ more }} más en {{ feed?.title }}
      </a>
      <p v-else-if="more > 0" class="fs__lead">y {{ more }} más en {{ feed?.title }}</p>
    </template>
    <p v-else class="fs__lead">Lo toma lo primero que pase a Refine o a Build; aprobar un PRD también lo ocupa.</p>
  </div>
</template>

<style scoped>
.fs { display: flex; flex-direction: column; gap: 0.15rem; padding-top: 0.5rem; }
.fs__lead { margin: 0; color: var(--fg-mute); font-size: var(--fs-chrome); line-height: 1.45; }
.fs__list { list-style: none; margin: 0; padding: 0; }
.fs__row { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
.fs__title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-mute); font-size: var(--fs-chrome); }
.fs__more { display: inline-flex; align-items: center; align-self: flex-start; min-height: var(--tap-h); color: var(--info); font-size: var(--fs-chrome); }
.fs__more:hover { background: none; color: var(--fg); text-decoration: underline; }
.fs__more:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
</style>
