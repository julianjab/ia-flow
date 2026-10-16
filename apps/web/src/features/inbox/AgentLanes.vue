<script setup lang="ts">
import type { ExecutionAgent } from '@ia-flow/shared';
import { computed } from 'vue';
import { lanesOf } from '@/features/inbox/queue/agents';

// Los agentes de una ejecución que corre más de uno (en paralelo), cada uno con su estado:
// «reviewer ✓ · e2e-visual-qa ● hace 2 min». Con uno solo, o sin `agents`, no dibuja nada: quien
// lo usa muestra el `agent_id` de siempre. No se toca (no es presionable): es una línea de meta,
// y por eso puede ir dentro de la fila-botón de `ExecutionRow` — sólo `span`.

const props = defineProps<{ agents?: readonly ExecutionAgent[] }>();
const lanes = computed(() => lanesOf(props));
</script>

<template>
  <span v-if="lanes.length" class="al" role="list" aria-label="agentes" data-test="agent-lanes">
    <span
      v-for="lane in lanes"
      :key="lane.id"
      class="al__lane"
      role="listitem"
      :data-state="lane.state"
      :data-tone="lane.tone"
      :title="`${lane.id}: ${lane.label}${lane.idle ? `, último paso ${lane.idle}` : ''}`"
    >
      <span class="al__name">{{ lane.id }}</span>
      <span class="al__glyph" aria-hidden="true">{{ lane.glyph }}</span>
      <span class="sr-only">{{ lane.label }}</span>
      <span v-if="lane.idle" class="al__idle">{{ lane.idle }}</span>
    </span>
  </span>
</template>

<style scoped>
.al { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 0 0.35rem; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-micro); color: var(--fg-dim); }
.al__lane { display: inline-flex; align-items: baseline; gap: 0.3rem; min-width: 0; }
/* El separador va pegado a la siguiente: si una envuelve, no cuelga un «·» al final de la línea. */
.al__lane + .al__lane::before { content: '·'; margin-right: 0.05rem; color: var(--fg-dimmer); }
.al__name { color: var(--fg-mute); overflow-wrap: anywhere; }
.al__glyph { color: var(--fg-dim); }
.al__lane[data-tone='live'] .al__glyph { color: var(--accent); animation: blink 1.6s ease-in-out infinite; }
.al__lane[data-tone='ok'] .al__glyph { color: var(--accent); }
.al__lane[data-tone='warn'] .al__glyph { color: var(--warn); }
.al__lane[data-tone='bad'] .al__glyph,
.al__lane[data-tone='bad'] .al__name { color: var(--danger); }
.al__lane[data-tone='dim'] .al__glyph { color: var(--fg-dimmer); }
.al__idle { color: var(--fg-dim); font-variant-numeric: tabular-nums; white-space: nowrap; }
@media (prefers-reduced-motion: reduce) {
  .al__lane[data-tone='live'] .al__glyph { animation: none; }
}
</style>
