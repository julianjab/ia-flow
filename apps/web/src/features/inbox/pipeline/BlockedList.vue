<script setup lang="ts">
import { computed } from 'vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import Disclosure from '@/features/inbox/Disclosure.vue';
import type { BlockedEntry } from '@/features/inbox/queue/runnerFeed';
import { useInboxStore } from '@/features/inbox/store';

// Las tarjetas que esperan a OTRA tarea (`dep`): no son ejecuciones en cola —no ocupan ni esperan
// un lugar del runner—, así que no cuentan en «en cola». Una línea plegada «N esperan a otra
// tarea» dentro del bloque del pipeline; abierta, cada una con a quién espera. Sin ninguna, nada.
// El título abre el detalle.

const props = defineProps<{ blocked: readonly BlockedEntry[] }>();
const store = useInboxStore();
const title = computed(() => {
  const n = props.blocked.length;
  return `${n} ${n === 1 ? 'espera' : 'esperan'} a otra tarea`;
});
</script>

<template>
  <Disclosure v-if="blocked.length" :title="title" tag="span" bare class="bl" data-test="blocked">
    <ul class="bl__list">
      <li v-for="b in blocked" :key="b.ref" class="bl__row">
        <button type="button" class="bl__title" :data-test="`open-${b.ref}`" @click="store.expand(b.ref)">{{ b.title }}</button>
        <span class="bl__meta">
          <RefLink :short="b.short" :url="b.url" />
          <template v-if="b.waitingOn">
            <span class="bl__wait mono">○ espera</span>
            <RefLink v-if="b.waitingOn.url" :short="b.waitingOn.short" :url="b.waitingOn.url" />
            <span v-else class="mono">{{ b.waitingOn.short }}</span>
          </template>
        </span>
      </li>
    </ul>
  </Disclosure>
</template>

<style scoped>
.bl { border-top: 1px solid var(--border-mute); }
.bl :deep(.dz__sum) { font-size: var(--fs-chrome); }
.bl__list { list-style: none; margin: 0; padding: 0; }
.bl__row { display: flex; flex-direction: column; padding: 0.25rem 0; }
.bl__row + .bl__row { border-top: 1px solid var(--border-mute); }
.bl__title { padding: 0; border: 0; background: none; color: var(--fg); font: inherit; font-size: var(--fs-body-sm); line-height: 1.35; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
.bl__title:hover { color: var(--accent); }
.bl__title:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
.bl__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.5rem; color: var(--fg-dim); font-size: var(--fs-micro); }
.bl__wait { color: var(--warn); }
</style>
