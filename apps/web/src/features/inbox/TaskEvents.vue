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

const props = defineProps<{ taskRef: string; events: EventLogEntry[] }>();

const SHOWN = 6;
// Llegan de lo más nuevo a lo más viejo (`TaskDetail.events`).
const recent = computed(() => props.events.slice(0, SHOWN));

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

function summary(entry: { summary: Record<string, string | number | boolean> }): string {
  return Object.entries(entry.summary)
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
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
      <li v-for="e in recent" :key="e.id" class="ev__item">
        <p class="ev__line">
          <span class="ev__dim mono">{{ clock(e.occurred_at) }}</span>
          <span class="mono">{{ e.type }}</span>
          <span class="ev__outcome" :data-outcome="e.outcome">{{ e.outcome }}</span>
        </p>
        <p v-if="summary(e)" class="ev__dim mono ev__sum">{{ summary(e) }}</p>
        <p v-if="e.error" class="ev__err">✕ {{ e.error }}</p>
        <ul v-if="e.decisions.length" class="ev__decisions">
          <li v-for="d in e.decisions" :key="`${d.source_id}/${d.pipeline_id}`">
            <span :class="['ev__verdict', `ev__verdict--${d.verdict}`]" :title="VERDICT[d.verdict]">{{ GLYPH[d.verdict] }}</span>
            <span class="mono">{{ d.pipeline_id }}</span>
            <span class="ev__dim">{{ VERDICT[d.verdict] }}<template v-if="d.reason"> — {{ d.reason }}</template></span>
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.ev { display: flex; flex-direction: column; gap: 0.4rem; }
.ev__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.ev__why { padding: 0 0.5rem; }
.ev__list, .ev__decisions { list-style: none; margin: 0; padding: 0; }
.ev__item { padding: 0.35rem 0; border-top: 1px solid var(--border-mute); }
.ev__decisions { display: flex; flex-direction: column; padding-left: 0.5rem; }
.ev__decisions li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem; font-size: var(--fs-body-sm); }
.ev__line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.6rem; margin: 0; font-size: var(--fs-body-sm); }
.ev__sum { margin: 0; font-size: var(--fs-micro); overflow-wrap: anywhere; }
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
