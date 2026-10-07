<script setup lang="ts">
import type { Reason } from '@/features/inbox/queue/entries';

// Por qué una decisión está en su lugar: los chips del dashboard (o los que se deducen con un
// runner viejo). No son presionables: miden `--row-h`, y el tono (hot/warn/bad) va en el texto y
// en un fondo de estado sin borde — la excepción documentada en DESIGN_SYSTEM «Chip / tag».

defineProps<{ reasons: readonly Reason[] }>();
</script>

<template>
  <span v-for="r in reasons" :key="r.text" class="why mono" :data-tone="r.tone">{{ r.text }}</span>
</template>

<style scoped>
.why {
  line-height: var(--row-h);
  padding: 0 0.4rem;
  border-radius: var(--radius-sm);
  background: var(--panel-hi);
  color: var(--fg-mute);
  font-size: var(--fs-micro);
  overflow-wrap: anywhere;
}
.why[data-tone='hot'] { background: var(--green-bg); color: var(--accent); }
.why[data-tone='warn'] { background: var(--yellow-bg); color: var(--warn); }
.why[data-tone='bad'] { background: var(--red-bg); color: var(--danger); }
</style>
