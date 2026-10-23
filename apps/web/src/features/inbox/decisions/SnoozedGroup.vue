<script setup lang="ts">
import { computed, ref } from 'vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import { shortRef } from '@/features/inbox/queue/shortRef';
import { useInboxStore } from '@/features/inbox/store';

// «Pospuestas · N»: las decisiones que quien mira sacó del medio. Plegado al final de «Para mí»;
// cada una vuelve sola cuando cambia algo (o vence su plazo) y desde acá se trae a mano. No
// cuentan en el titular ni en el badge. Debajo, el aviso de la última, con «Deshacer».

const store = useInboxStore();
const open = ref(false);
const items = computed(() => store.snoozed);
</script>

<template>
  <div class="sz">
    <p v-if="store.lastSnoozed" class="sz__toast" role="status">
      Pospuesta {{ store.lastSnoozed.until ? 'hasta el plazo' : 'hasta que cambie algo' }} ·
      <button type="button" class="sz__undo" data-test="undo-snooze" @click="store.undoSnooze()">Deshacer</button>
    </p>
    <section v-if="items.length" class="sz__box" aria-labelledby="snoozed-h">
      <button type="button" class="sz__head" :aria-expanded="open" aria-controls="snoozed-list" @click="open = !open">
        <span id="snoozed-h" class="sz__title">Pospuestas · {{ items.length }}</span>
        <span class="sz__hint">vuelven cuando cambien {{ open ? '▴' : '▾' }}</span>
      </button>
      <ul v-show="open" id="snoozed-list" class="sz__list">
        <li v-for="item in items" :key="item.ref" class="sz__row">
          <span class="sz__what">
            <span class="sz__name">{{ item.title }}</span>
            <RefLink :short="shortRef(item.ref)" :url="item.url" />
          </span>
          <button type="button" class="btn btn--ghost" :data-test="`wake-${item.ref}`" @click="store.wake(item.ref)">Traer de vuelta</button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.sz { display: flex; flex-direction: column; gap: 0.6rem; }
.sz__toast { margin: 0; padding: 0.6rem 0.75rem; border-radius: var(--radius); background: var(--green-bg); color: var(--accent); font-size: var(--fs-body-sm); }
.sz__undo { min-height: var(--tap-h-sm); padding: 0 0.25rem; border: 0; background: none; color: var(--info); font: inherit; text-decoration: underline; cursor: pointer; }
.sz__box { border: 1px dashed var(--border-hi); border-radius: var(--radius); }
.sz__head { display: flex; align-items: center; gap: 0.5rem; width: 100%; min-height: var(--tap-h); padding: 0 0.85rem; border: 0; background: none; color: var(--fg-mute); font: inherit; text-align: left; cursor: pointer; }
.sz__title { flex: 1; }
.sz__hint { color: var(--fg-dim); font-size: var(--fs-chrome); }
.sz__list { list-style: none; margin: 0; padding: 0; }
.sz__row { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.85rem; border-top: 1px solid var(--border-mute); }
.sz__what { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.sz__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
