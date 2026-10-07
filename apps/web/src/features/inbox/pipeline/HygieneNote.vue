<script setup lang="ts">
import { computed } from 'vue';
import type { HygieneLine } from '@/features/inbox/view/decide';

// «Higiene del board»: texto chico, sólo las líneas que cuentan algo. No es una decisión.

const props = defineProps<{ lines: readonly HygieneLine[] }>();
const shown = computed(() => props.lines.filter((line) => line.count > 0));
</script>

<template>
  <section v-if="shown.length" class="hy" aria-labelledby="hy-h">
    <h2 id="hy-h" class="uc-label hy__hd">Higiene del board</h2>
    <p v-for="line in shown" :key="line.text" class="hy__line">{{ line.text }}</p>
  </section>
</template>

<style scoped>
.hy { display: flex; flex-direction: column; gap: 0.2rem; padding: 0 0.25rem; }
.hy__hd { margin: 0 0 0.1rem; font-weight: 400; }
.hy__line { margin: 0; color: var(--fg-dim); font-size: var(--fs-chrome); line-height: 1.45; }
</style>
