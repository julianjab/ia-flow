<script setup lang="ts">
import type { EventLogEntry, ExplainResult, PipelineDecision } from '@ia-flow/shared';
import { computed, ref } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { explainTask } from '@/features/inbox/api';
import { clock } from '@/features/inbox/format';

// Los últimos eventos que recibió la tarea y qué decidió cada pipeline con
// ellos, más "¿por qué no corrió?": las decisiones del engine para un evento
// contra la card. Es la respuesta a la pregunta que más se repite cuando una
// tarjeta no se mueve.

// `limit`: cuántos se muestran (el panel grande los muestra todos).
const props = withDefaults(defineProps<{ taskRef: string; events: EventLogEntry[]; limit?: number }>(), {
  limit: 6,
});

// Llegan de lo más nuevo a lo más viejo (`TaskDetail.events`).
const recent = computed(() => props.events.slice(0, props.limit));

const GLYPH: Record<PipelineDecision['verdict'], string> = {
  ran: '✓',
  mismatch: '○',
  lost_to_exclusive: '⛔',
};
const VERDICT: Record<PipelineDecision['verdict'], string> = {
  ran: 'corrió',
  mismatch: 'no aplicó',
  lost_to_exclusive: 'perdió el turno',
};

/** Los datos del evento en una línea. `issue` es la propia tarea: no dice nada acá. */
function summary(entry: { summary: Record<string, string | number | boolean> }): string {
  return Object.entries(entry.summary)
    .filter(([k]) => k !== 'issue')
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
}

/** Qué pasó con el evento, en corto: las pipelines que corrieron por nombre; el resto, contadas. */
function tally(decisions: PipelineDecision[]): { ran: string; rest: string } {
  const ran = decisions.filter((d) => d.verdict === 'ran').map((d) => d.pipeline_id);
  const lost = decisions.filter((d) => d.verdict === 'lost_to_exclusive').length;
  const skipped = decisions.filter((d) => d.verdict === 'mismatch').length;
  const rest = [
    lost ? `${lost} perdió el turno` : '',
    skipped ? `${skipped} ${skipped === 1 ? 'no aplicó' : 'no aplicaron'}` : '',
  ].filter(Boolean);
  return { ran: ran.length ? `✓ corrió ${ran.join(', ')}` : '', rest: rest.join(' · ') };
}

/** «no cumple: A (vino x); B (vino y)» → una condición por renglón. */
function reasons(reason: string | undefined): string[] {
  if (!reason) return [];
  const [head, body] = reason.includes(': ') ? reason.split(/: (.*)/s) : ['', reason];
  return (body ?? '').split('; ').map((part, i) => (i === 0 && head ? `${head}: ${part}` : part));
}

const explain = ref<ExplainResult | null>(null);
const explaining = ref(false);
const explainError = ref<string | null>(null);

async function why() {
  explaining.value = true;
  explainError.value = null;
  try {
    explain.value = await explainTask(props.taskRef);
  } catch (err) {
    explainError.value = extractErrorMessage(err);
  } finally {
    explaining.value = false;
  }
}
</script>

<template>
  <section class="ev" aria-label="Eventos y decisiones">
    <div class="ev__head">
      <span class="uc-label">eventos recientes</span>
      <button type="button" class="btn btn--ghost ev__why" :disabled="explaining" @click="why">
        {{ explaining ? 'evaluando…' : '¿Por qué no corrió?' }}
      </button>
    </div>

    <div v-if="explain" class="ev__explain">
      <p class="ev__line">
        <span class="mono">{{ explain.event.type }}</span>
        <span class="ev__dim">
          {{ explain.source === 'last_event' ? 'el último que recibió la tarea' : 'armado para la pregunta' }}
        </span>
      </p>
      <p v-if="summary(explain.event)" class="ev__dim mono">{{ summary(explain.event) }}</p>
      <ul class="ev__decisions">
        <li v-for="d in explain.decisions" :key="`${d.source_id}/${d.pipeline_id}`">
          <span :class="['ev__verdict', `ev__verdict--${d.verdict}`]" :title="VERDICT[d.verdict]">{{ GLYPH[d.verdict] }}</span>
          <span class="mono">{{ d.pipeline_id }}</span>
          <span class="ev__dim">{{ VERDICT[d.verdict] }}<template v-if="d.reason"> — {{ d.reason }}</template></span>
        </li>
        <li v-if="!explain.decisions.length" class="ev__dim">· ninguna pipeline escucha este evento</li>
      </ul>
    </div>
    <p v-if="explainError" class="ev__err" role="alert">✕ {{ explainError }}</p>

    <ul v-if="recent.length" class="ev__list">
      <!-- Cada evento, colapsado: qué llegó y qué hizo cada pipeline en una línea; abierto, por qué. -->
      <li v-for="e in recent" :key="e.id">
        <details class="ev__item" :open="e.outcome === 'error'">
          <summary class="ev__row">
            <span class="ev__chev" aria-hidden="true">▸</span>
            <span class="ev__main">
              <span class="ev__line">
                <span class="ev__dim mono">{{ clock(e.occurred_at) }}</span>
                <span class="mono ev__type">{{ e.type }}</span>
                <span class="ev__outcome" :data-outcome="e.outcome">{{ e.outcome }}</span>
                <span v-if="tally(e.decisions).ran" class="ev__ran">{{ tally(e.decisions).ran }}</span>
                <span v-if="tally(e.decisions).rest" class="ev__dim">{{ tally(e.decisions).rest }}</span>
              </span>
              <span v-if="summary(e)" class="ev__dim mono ev__sum">{{ summary(e) }}</span>
            </span>
          </summary>
          <div class="ev__body">
            <p v-if="e.error" class="ev__err">✕ {{ e.error }}</p>
            <ul v-if="e.decisions.length" class="ev__decisions">
              <li v-for="d in e.decisions" :key="`${d.source_id}/${d.pipeline_id}`" class="ev__decision">
                <span class="ev__who">
                  <span :class="['ev__verdict', `ev__verdict--${d.verdict}`]" aria-hidden="true">{{ GLYPH[d.verdict] }}</span>
                  <span class="mono">{{ d.pipeline_id }}</span>
                  <span class="ev__dim">{{ VERDICT[d.verdict] }}</span>
                </span>
                <span v-for="(line, i) in reasons(d.reason)" :key="i" class="ev__reason">{{ line }}</span>
              </li>
            </ul>
            <p v-else class="ev__dim">· ninguna pipeline escucha este evento</p>
          </div>
        </details>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.ev { display: flex; flex-direction: column; gap: 0.4rem; }
.ev__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.ev__why { padding: 0 0.5rem; }
.ev__list, .ev__decisions { list-style: none; margin: 0; padding: 0; }
.ev__item { border-top: 1px solid var(--border-mute); }
/* La fila entera es el blanco táctil (R1); la flecha dice si está abierta. */
.ev__row { display: flex; align-items: flex-start; gap: 0.5rem; min-height: var(--tap-h); padding: 0.4rem 0; cursor: pointer; list-style: none; }
.ev__row::-webkit-details-marker { display: none; }
.ev__row:hover .ev__type { text-decoration: underline; }
.ev__row:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.ev__chev { flex: none; color: var(--fg-dim); font-size: var(--fs-micro); line-height: 1.7; transition: transform 120ms ease; }
.ev__item[open] .ev__chev { transform: rotate(90deg); }
.ev__main { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
.ev__ran { color: var(--accent); font-size: var(--fs-body-sm); }
/* Colapsado, los datos van en una línea; abierto, enteros. */
.ev__sum { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ev__item[open] .ev__sum { white-space: normal; overflow-wrap: anywhere; }
.ev__body { display: flex; flex-direction: column; gap: 0.4rem; padding: 0 0 0.6rem 1.4rem; }
.ev__decisions { display: flex; flex-direction: column; gap: 0.4rem; }
.ev__decision { display: flex; flex-direction: column; gap: 0.1rem; }
.ev__who { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem; font-size: var(--fs-body-sm); }
/* Una condición por renglón, bajo su pipeline. */
.ev__reason { padding-left: 1.7ch; color: var(--fg-mute); font-family: var(--font-mono); font-size: var(--fs-micro); overflow-wrap: anywhere; }
/* Las decisiones del «¿por qué no corrió?» siguen en una línea cada una. */
.ev__explain .ev__decisions li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem; font-size: var(--fs-body-sm); }
.ev__line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.6rem; margin: 0; font-size: var(--fs-body-sm); }
.ev__explain .ev__sum { margin: 0; white-space: normal; overflow-wrap: anywhere; }
.ev__sum { font-size: var(--fs-micro); }
.ev__dim { color: var(--fg-dim); font-size: var(--fs-body-sm); }
.ev__err { margin: 0; color: var(--danger); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.ev__explain { padding: 0.5rem 0.6rem; border: 1px solid var(--border-hi); border-radius: var(--radius); background: var(--panel-alt); }
.ev__verdict { flex: none; width: 1.2ch; }
.ev__verdict--ran { color: var(--accent); }
.ev__verdict--mismatch { color: var(--fg-dim); }
.ev__verdict--lost_to_exclusive { color: var(--warn); }
/* Chip: una caja, el color lo da el glifo/estado (DESIGN_SYSTEM «Chip / tag»). */
.ev__outcome {
  line-height: var(--row-h);
  padding: 0 0.4rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}
.ev__outcome[data-outcome='error'] { color: var(--danger); border-color: var(--danger); }
.ev__outcome[data-outcome='dispatched'],
.ev__outcome[data-outcome='resumed'] { color: var(--accent); }
</style>
