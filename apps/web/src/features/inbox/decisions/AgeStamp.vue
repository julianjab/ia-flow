<script setup lang="ts">
import type { Age } from '@/features/inbox/queue/age';

// Cuánto lleva esperando: mono, cifras tabulares, en --warn desde las 24 h.

defineProps<{ age: Age; prefix?: string }>();
</script>

<template>
  <time v-if="age.text" class="age mono" :class="{ 'age--old': age.old }" :datetime="age.iso" :title="age.iso"
    >{{ prefix ? `${prefix} ` : '' }}{{ age.text }}</time
  >
</template>

<style scoped>
.age { color: var(--fg-dim); font-size: var(--fs-chrome); font-variant-numeric: tabular-nums; white-space: nowrap; }
.age--old { color: var(--warn); }
</style>
