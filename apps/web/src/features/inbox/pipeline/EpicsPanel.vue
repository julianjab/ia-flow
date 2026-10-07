<script setup lang="ts">
import { computed } from 'vue';
import Disclosure from '@/features/inbox/Disclosure.vue';
import EpicEntry from '@/features/inbox/pipeline/EpicEntry.vue';
import type { EpicLine } from '@/features/inbox/queue/epics';

// «Dónde se traba cada épica»: una entrada por épica con decisiones en la cola, en el orden de su
// primera decisión. Al costado desde 1100 px; por debajo (`folded`), plegada como «Épicas» con
// cuántas están trabadas en vos. Sin épicas no se dibuja.

const props = defineProps<{ epics: readonly EpicLine[]; folded?: boolean }>();
const stuck = computed(() => {
  const n = props.epics.length;
  return `${n} ${n === 1 ? 'trabada' : 'trabadas'} en vos`;
});
</script>

<template>
  <template v-if="epics.length">
    <Disclosure v-if="folded" title="Épicas" data-test="epics">
      <template #meta>
        <span class="ep__stuck" data-test="epics-stuck">{{ stuck }}</span>
      </template>
      <ul class="ep__list ep__list--folded">
        <EpicEntry v-for="epic in epics" :key="epic.ref" :epic="epic" />
      </ul>
    </Disclosure>

    <section v-else class="ep" aria-labelledby="ep-h" data-test="epics">
      <h2 id="ep-h" class="sec-hd ep__hd">Dónde se traba cada épica</h2>
      <ul class="ep__list">
        <EpicEntry v-for="epic in epics" :key="epic.ref" :epic="epic" />
      </ul>
    </section>
  </template>
</template>

<style scoped src="@/features/inbox/section.css" />
<style scoped>
.ep { display: flex; flex-direction: column; padding: 0.8rem 0.9rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.ep__hd { padding-bottom: 0.35rem; }
.ep__stuck { color: var(--warn); font-size: var(--fs-micro); }
.ep__list { list-style: none; margin: 0; padding: 0; }
.ep__list--folded { padding: 0 0.75rem; }
.ep__list:not(.ep__list--folded) > :first-child { border-top: 0; }
@media (min-width: 640px) {
  .ep__list--folded { padding: 0 1rem; }
}
</style>
