<script setup lang="ts">
import ActionButton from '@/features/inbox/decisions/ActionButton.vue';
import AgeStamp from '@/features/inbox/decisions/AgeStamp.vue';
import ReasonChips from '@/features/inbox/decisions/ReasonChips.vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import type { QueueEntry } from '@/features/inbox/queue/entries';

// Una tarea dentro de un grupo («Mergear 2 PRs»): su título, su link, su razón, su antigüedad y su
// propio botón, con su confirmación y su error. Si el botón del grupo corta en ésta, el error queda acá.

defineProps<{ entry: QueueEntry }>();
</script>

<template>
  <li :id="`card-${entry.ref}`" class="dc">
    <div class="dc__what">
      <span class="dc__title">{{ entry.title }}</span>
      <span class="dc__why">
        <RefLink :short="entry.short" :url="entry.url" />
        <ReasonChips :reasons="entry.reasons.slice(0, 1)" />
        <AgeStamp :age="entry.age" />
      </span>
    </div>
    <ActionButton v-if="entry.action" ghost :action="entry.action" :item="entry.item" />
  </li>
</template>

<style scoped>
.dc { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.6rem; padding: 0.35rem 0.35rem 0.35rem 0.75rem; }
.dc + .dc { border-top: 1px solid var(--border-mute); }
.dc__what { flex: 1 1 14rem; min-width: 0; display: flex; flex-direction: column; }
.dc__title { color: var(--fg); font-size: var(--fs-body-sm); line-height: 1.4; overflow-wrap: anywhere; }
.dc__why { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.5rem; }
.dc :deep(.btn--ghost) { color: var(--fg-mute); }
</style>
