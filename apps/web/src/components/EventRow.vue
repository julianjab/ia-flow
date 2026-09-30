<script setup lang="ts">
import type { EventLogEntry } from '@ia-flow/shared';
import { computed } from 'vue';
import { clock, eventSummary, GLYPH, reasons, tally, VERDICT } from '@/components/eventText';

// Un evento del log, plegado: cuándo, qué, cómo terminó, qué corrió y sus datos
// en una línea; abierto, cada pipeline con su veredicto y cada condición que la
// cortó en su renglón. Uno con error arranca abierto.

const props = withDefaults(
  defineProps<{
    event: EventLogEntry;
    /** Claves del resumen que ya dice el contexto (en el detalle de una tarea, `issue`). */
    hide?: readonly string[];
    /** Mostrar de qué tarea es (en una lista que mezcla tareas). */
    showTask?: boolean;
  }>(),
  { hide: () => [], showTask: false },
);

const counts = computed(() => tally(props.event.decisions));
const line = computed(() => eventSummary(props.event.summary, props.hide));
</script>

<template>
  <details class="er" :open="event.outcome === 'error'">
    <summary class="er__row">
      <span class="er__chev" aria-hidden="true">▸</span>
      <span class="er__main">
        <span class="er__line">
          <span class="er__dim mono">{{ clock(event.occurred_at) }}</span>
          <span class="mono er__type">{{ event.type }}</span>
          <span class="er__outcome" :data-outcome="event.outcome">{{ event.outcome }}</span>
          <span v-if="counts.ran" class="er__ran">{{ counts.ran }}</span>
          <span v-if="counts.rest" class="er__dim">{{ counts.rest }}</span>
        </span>
        <span v-if="showTask && event.task_ref" class="er__task mono">{{ event.task_ref }}</span>
        <span v-if="line" class="er__dim mono er__sum">{{ line }}</span>
      </span>
    </summary>
    <div class="er__body">
      <p v-if="event.error" class="er__err">✕ {{ event.error }}</p>
      <ul v-if="event.decisions.length" class="er__decisions">
        <li v-for="d in event.decisions" :key="`${d.source_id}/${d.pipeline_id}`" class="er__decision">
          <span class="er__who">
            <span :class="['er__verdict', `er__verdict--${d.verdict}`]" aria-hidden="true">{{ GLYPH[d.verdict] }}</span>
            <span class="mono">{{ d.pipeline_id }}</span>
            <span class="er__dim">{{ VERDICT[d.verdict] }}</span>
          </span>
          <span v-for="(reason, i) in reasons(d.reason)" :key="i" class="er__reason">{{ reason }}</span>
        </li>
      </ul>
      <p v-else class="er__dim">· ninguna pipeline escucha este evento</p>
    </div>
  </details>
</template>

<style scoped>
.er { border-top: 1px solid var(--border-mute); }
/* La fila entera es el blanco táctil (R1); la flecha dice si está abierta. */
.er__row { display: flex; align-items: flex-start; gap: 0.5rem; min-height: var(--tap-h); padding: 0.4rem 0; cursor: pointer; list-style: none; }
.er__row::-webkit-details-marker { display: none; }
.er__row:hover .er__type { text-decoration: underline; }
.er__row:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.er__chev { flex: none; color: var(--fg-dim); font-size: var(--fs-micro); line-height: 1.7; transition: transform 120ms ease; }
.er[open] .er__chev { transform: rotate(90deg); }
.er__main { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
.er__line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.6rem; font-size: var(--fs-body-sm); }
.er__ran { color: var(--accent); font-size: var(--fs-body-sm); }
.er__task { color: var(--fg); font-size: var(--fs-chrome); overflow-wrap: anywhere; }
.er__dim { color: var(--fg-dim); font-size: var(--fs-body-sm); }
/* Colapsado, los datos van en una línea; abierto, enteros. */
.er__sum { overflow: hidden; font-size: var(--fs-micro); text-overflow: ellipsis; white-space: nowrap; }
.er[open] .er__sum { white-space: normal; overflow-wrap: anywhere; }
.er__body { display: flex; flex-direction: column; gap: 0.4rem; padding: 0 0 0.6rem 1.4rem; }
.er__body p { margin: 0; }
.er__decisions { display: flex; flex-direction: column; gap: 0.4rem; margin: 0; padding: 0; list-style: none; }
.er__decision { display: flex; flex-direction: column; gap: 0.1rem; }
.er__who { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem; font-size: var(--fs-body-sm); }
/* Una condición por renglón, bajo su pipeline. */
.er__reason { padding-left: 1.7ch; color: var(--fg-mute); font-family: var(--font-mono); font-size: var(--fs-micro); overflow-wrap: anywhere; }
.er__err { color: var(--danger); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.er__verdict { flex: none; width: 1.2ch; }
.er__verdict--ran { color: var(--accent); }
.er__verdict--mismatch { color: var(--fg-dim); }
.er__verdict--lost_to_exclusive { color: var(--warn); }
/* Chip: una caja, el color lo da el estado (DESIGN_SYSTEM «Chip / tag»). */
.er__outcome { line-height: var(--row-h); padding: 0 0.4rem; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg-dim); font-family: var(--font-mono); font-size: var(--fs-micro); }
.er__outcome[data-outcome='error'] { border-color: var(--danger); color: var(--danger); }
.er__outcome[data-outcome='dispatched'],
.er__outcome[data-outcome='resumed'] { color: var(--accent); }
</style>
