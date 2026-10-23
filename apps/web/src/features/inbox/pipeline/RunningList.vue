<script setup lang="ts">
import AgentLanes from '@/features/inbox/AgentLanes.vue';
import ActionButton from '@/features/inbox/decisions/ActionButton.vue';
import AgeStamp from '@/features/inbox/decisions/AgeStamp.vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import type { RunningEntry } from '@/features/inbox/queue/build';
import { useInboxStore } from '@/features/inbox/store';

// Lo que corre ahora (o, con `waiting`, lo que espera su turno): título, link, agente (o los agentes
// en paralelo, cada uno con su estado), cuánto
// lleva y «Detener…» si el runner lo ofrece. No son tarjetas: no hay nada que decidir. El título
// abre el detalle (la traza en vivo de lo que corre).

defineProps<{ running: RunningEntry[]; waiting?: boolean }>();
const store = useInboxStore();
</script>

<template>
  <ul class="rl">
    <li v-for="r in running" :id="`card-${r.ref}`" :key="r.ref" class="rl__row" data-test="running">
      <span v-if="waiting" class="rl__wait" aria-hidden="true" />
      <span v-else class="live-dot" aria-hidden="true" />
      <div class="rl__what">
        <button type="button" class="rl__title" :data-test="`open-${r.ref}`" @click="store.expand(r.ref)">{{ r.title }}</button>
        <span class="rl__meta">
          <RefLink :short="r.short" :url="r.url" />
          <!-- El separador va pegado a su dato: si falta el agente o la antigüedad, no cuelga un «·». -->
          <!-- Varios agentes en paralelo: cada uno con su estado, en vez del último que cerró. -->
          <template v-if="r.agents"><span aria-hidden="true">·</span><AgentLanes :agents="r.agents" /></template>
          <span v-else-if="r.agent">· {{ r.agent }}</span>
          <template v-if="r.age.text"><span aria-hidden="true">·</span><AgeStamp :age="r.age" /></template>
        </span>
      </div>
      <ActionButton v-if="r.stop" ghost :action="r.stop" :item="{ ref: r.ref }" />
    </li>
  </ul>
</template>

<style scoped>
.rl { list-style: none; margin: 0; padding: 0; }
.rl__row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.6rem; padding: 0.4rem 0; }
.rl__row + .rl__row { border-top: 1px solid var(--border-mute); }
.rl__wait { flex: none; width: 0.4rem; height: 0.4rem; background: var(--fg-dim); }
.rl__what { flex: 1 1 12rem; min-width: 0; display: flex; flex-direction: column; }
.rl__title { padding: 0; border: 0; background: none; color: var(--fg); font: inherit; font-size: var(--fs-body); line-height: 1.35; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
.rl__title:hover { color: var(--info); }
.rl__title:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
.rl__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.35rem; color: var(--fg-dim); font-size: var(--fs-chrome); }
</style>
