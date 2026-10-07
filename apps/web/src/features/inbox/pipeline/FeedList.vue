<script setup lang="ts">
import { computed } from 'vue';
import { useIsMobile } from '@/composables/useIsMobile';
import ActionButton from '@/features/inbox/decisions/ActionButton.vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import Disclosure from '@/features/inbox/Disclosure.vue';
import type { FeedLine, FeedSummary } from '@/features/inbox/queue/build';
import type { QueueAction } from '@/features/inbox/queue/kinds';

// «Qué le das al pipeline», debajo de la cola: una línea por tarea lista para arrancar (estado,
// link, título truncado y la acción que la pone a correr). El encabezado dice cuántos lugares
// libres hay para llenar (como el mockup: es la pregunta que contesta el feed) y cuántas hay
// listas. En el teléfono arranca plegado.

const props = defineProps<{ feed: FeedSummary }>();
const { isMobile } = useIsMobile();

/** Mover una card al pipeline es reversible: no confirma, pero va firmado con tu usuario. */
const actionOf = (line: FeedLine): QueueAction | null =>
  line.action ? { id: line.action.id, label: `→ ${line.action.label}`, confirms: false } : null;
const lines = computed(() => props.feed.entries.map((line) => ({ ...line, act: actionOf(line) })));
const n = computed(() => props.feed.entries.length);
const free = computed(() => {
  const free = props.feed.free;
  if (free === undefined) return null;
  return `${free} ${free === 1 ? 'lugar libre' : 'lugares libres'}`;
});
</script>

<template>
  <Disclosure :title="feed.title" :open="!isMobile" data-test="feed">
    <template #meta>
      <span v-if="free" class="uc-label fl__free" data-test="feed-free">{{ free }}</span>
      <span v-if="n" class="fl__slots">{{ n }} {{ n === 1 ? 'lista para correr' : 'listas para correr' }}</span>
      <span v-else class="fl__slots">nada listo para correr</span>
    </template>
    <ul v-if="n" class="fl__list">
      <li v-for="line in lines" :key="line.ref" class="fl__row">
        <span class="fl__state mono">● lista</span>
        <RefLink :short="line.short" :url="line.url" />
        <span class="fl__title" :title="line.title">{{ line.title }}</span>
        <ActionButton v-if="line.act" ghost :action="line.act" :item="{ ref: line.ref }" />
      </li>
    </ul>
  </Disclosure>
</template>

<style scoped>
.fl__free { color: var(--accent); }
.fl__slots { color: var(--fg-dim); font-size: var(--fs-chrome); }
.fl__list { list-style: none; margin: 0; padding: 0; }
.fl__row { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.75rem; min-height: var(--tap-h); padding: 0 0.35rem 0 0.75rem; border-top: 1px solid var(--border-mute); }
.fl__state { flex: none; color: var(--accent); font-size: var(--fs-micro); }
.fl__title { flex: 1 1 8rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-mute); font-size: var(--fs-body-sm); }
.fl__row :deep(.btn--ghost) { color: var(--accent); }
@media (min-width: 640px) {
  /* Sigue en wrap: el título ya trunca, y el error o el ✓ de la acción bajan a su propia línea. */
  .fl__row { padding-left: 1rem; }
}
</style>
