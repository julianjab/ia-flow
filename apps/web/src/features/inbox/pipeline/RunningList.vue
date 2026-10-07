<script setup lang="ts">
import ActionButton from '@/features/inbox/decisions/ActionButton.vue';
import AgeStamp from '@/features/inbox/decisions/AgeStamp.vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import type { RunningEntry } from '@/features/inbox/queue/build';

// Lo que corre ahora (o, con `waiting`, lo que espera su turno): título, link, agente, cuánto
// lleva y «Detener…» si el runner lo ofrece. No son tarjetas: no hay nada que decidir.

defineProps<{ running: RunningEntry[]; waiting?: boolean }>();
</script>

<template>
  <ul class="rl">
    <li v-for="r in running" :id="`card-${r.ref}`" :key="r.ref" class="rl__row" data-test="running">
      <span v-if="waiting" class="rl__wait" aria-hidden="true" />
      <span v-else class="live-dot" aria-hidden="true" />
      <div class="rl__what">
        <span class="rl__title">{{ r.title }}</span>
        <span class="rl__meta">
          <RefLink :short="r.short" :url="r.url" />
          <span v-if="r.agent" class="mono">· {{ r.agent }}</span>
          <span aria-hidden="true">·</span>
          <AgeStamp :age="r.age" />
        </span>
      </div>
      <ActionButton v-if="r.stop" ghost :action="r.stop" :item="{ ref: r.ref }" />
    </li>
  </ul>
</template>

<style scoped>
.rl { list-style: none; margin: 0; padding: 0; }
.rl__row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.6rem; padding: 0.25rem 0; }
.rl__row + .rl__row { border-top: 1px solid var(--border-mute); }
.rl__wait { flex: none; width: 0.4rem; height: 0.4rem; background: var(--fg-dim); }
.rl__what { flex: 1 1 12rem; min-width: 0; display: flex; flex-direction: column; }
.rl__title { color: var(--fg); font-size: var(--fs-body-sm); line-height: 1.35; overflow-wrap: anywhere; }
.rl__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.35rem; color: var(--fg-dim); font-size: var(--fs-micro); }
</style>
