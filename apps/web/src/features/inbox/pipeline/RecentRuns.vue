<script setup lang="ts">
import AgeStamp from '@/features/inbox/decisions/AgeStamp.vue';
import RefLink from '@/features/inbox/decisions/RefLink.vue';
import type { RecentRun } from '@/features/inbox/queue/recent';
import { useInboxStore } from '@/features/inbox/store';

// «Lo último que corrió»: las corridas que ya cerraron, con cómo terminaron (✓ / ✕ / ↷), quién,
// la salida si no fue la de siempre y hace cuánto. El título abre el detalle con su traza. Si una
// falló, también es una decisión: acá sólo se cuenta que pasó.

defineProps<{ runs: readonly RecentRun[] }>();
const store = useInboxStore();

const GLYPH: Record<RecentRun['status'], string> = { done: '✓', failed: '✕', superseded: '↷' };
const WORD: Record<RecentRun['status'], string> = { done: 'terminó', failed: 'falló', superseded: 'reemplazada' };
</script>

<template>
  <section v-if="runs.length" class="rr" aria-labelledby="rr-h">
    <h3 id="rr-h" class="rr__hd">Lo último que corrió</h3>
    <ul class="rr__list">
      <li v-for="r in runs" :key="r.ref" class="rr__row" :data-status="r.status" data-test="recent">
        <span class="rr__glyph" :title="WORD[r.status]" aria-hidden="true">{{ GLYPH[r.status] }}</span>
        <div class="rr__what">
          <button type="button" class="rr__title" :data-test="`recent-${r.ref}`" @click="store.expand(r.ref)">{{ r.title }}</button>
          <span class="rr__meta">
            <RefLink :short="r.short" :url="r.url" />
            <span aria-hidden="true">·</span><span>{{ r.agent }}</span>
            <span v-if="r.status === 'failed' || r.exit" aria-hidden="true">·</span>
            <span v-if="r.status === 'failed'" class="rr__bad">falló</span>
            <span v-else-if="r.exit" :title="`Salió por ${r.exit}`">→ {{ r.exit }}</span>
            <template v-if="r.age.text"><span aria-hidden="true">·</span><AgeStamp :age="{ ...r.age, old: false }" /></template>
          </span>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.rr { display: flex; flex-direction: column; gap: 0.25rem; }
.rr__hd { margin: 0; color: var(--fg-mute); font-size: var(--fs-chrome); font-weight: 500; }
.rr__list { list-style: none; margin: 0; padding: 0; }
.rr__row { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.4rem 0; }
.rr__row + .rr__row { border-top: 1px solid var(--border-mute); }
.rr__glyph { flex: none; width: 0.9rem; color: var(--accent); text-align: center; }
.rr__row[data-status='failed'] .rr__glyph { color: var(--danger); }
.rr__row[data-status='superseded'] .rr__glyph { color: var(--fg-dim); }
.rr__what { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.rr__title {
  display: -webkit-box;
  padding: 0;
  border: 0;
  background: none;
  color: var(--fg-mute);
  font: inherit;
  font-size: var(--fs-body-sm);
  line-height: 1.35;
  text-align: left;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  cursor: pointer;
}
.rr__title:hover { color: var(--info); }
.rr__title:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
.rr__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0 0.35rem; color: var(--fg-dim); font-size: var(--fs-chrome); }
.rr__bad { color: var(--danger); }
</style>
