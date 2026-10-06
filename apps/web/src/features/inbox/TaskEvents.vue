<script setup lang="ts">
import type { EventLogEntry, ExplainResult } from '@ia-flow/shared';
import { computed, ref } from 'vue';
import EventRow from '@/components/EventRow.vue';
import { eventSummary, GLYPH, VERDICT } from '@/components/eventText';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { explainTask } from '@/features/inbox/api';

// Los últimos eventos que recibió la tarea y qué decidió cada pipeline con
// ellos, más "¿por qué no corrió?": las decisiones del engine para un evento
// contra la card. Es la respuesta a la pregunta que más se repite cuando una
// tarjeta no se mueve. Cada evento es una `EventRow` (compartida con la
// pantalla de entradas).

// `limit`: cuántos se muestran (el panel grande los muestra todos).
const props = withDefaults(
  defineProps<{
    taskRef: string;
    events: EventLogEntry[];
    limit?: number;
    /** Las ejecuciones que se pueden abrir desde un evento (las de la lista de arriba). */
    executionIds?: readonly string[];
  }>(),
  { limit: 6, executionIds: () => [] },
);
const emit = defineEmits<{ (e: 'open-execution', id: string): void }>();

/** La ejecución que arrancó el evento, si está en la lista para abrirla. */
const runOf = (event: EventLogEntry) =>
  event.execution_id && props.executionIds.includes(event.execution_id) ? event.execution_id : undefined;

// Llegan de lo más nuevo a lo más viejo (`TaskDetail.events`).
const recent = computed(() => props.events.slice(0, props.limit));

/** `issue` es la propia tarea: no dice nada acá. */
const HIDE = ['issue'] as const;
const summary = (entry: { summary: Record<string, string | number | boolean> }) => eventSummary(entry.summary, HIDE);

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
        <EventRow :event="e" :hide="HIDE">
          <template v-if="runOf(e)" #aside>
            <button
              type="button"
              class="ev__run mono"
              :title="`Abrir la ejecución ${runOf(e)}`"
              :data-test="`open-execution-${runOf(e)}`"
              @click.prevent.stop="emit('open-execution', runOf(e) as string)"
            >
              → {{ (runOf(e) as string).slice(0, 8) }}
            </button>
          </template>
        </EventRow>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.ev { display: flex; flex-direction: column; gap: 0.4rem; }
.ev__head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.ev__why { padding: 0 0.5rem; }
/* El link a la ejecución: un chip que se toca entero (R1), dentro de la fila del evento. */
.ev__run { min-height: var(--tap-h); padding: 0 0.5rem; border: 1px solid var(--border-hi); border-radius: var(--radius-sm); background: none; color: var(--info); font-size: var(--fs-micro); cursor: pointer; }
.ev__run:hover { background: var(--panel-hi); }
.ev__list, .ev__decisions { list-style: none; margin: 0; padding: 0; }
.ev__decisions { display: flex; flex-direction: column; gap: 0.4rem; }
/* Las decisiones del «¿por qué no corrió?» siguen en una línea cada una. */
.ev__explain .ev__decisions li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem; font-size: var(--fs-body-sm); }
.ev__line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.6rem; margin: 0; font-size: var(--fs-body-sm); }
.ev__explain .ev__sum { margin: 0; font-size: var(--fs-micro); overflow-wrap: anywhere; }
.ev__dim { color: var(--fg-dim); font-size: var(--fs-body-sm); }
.ev__err { margin: 0; color: var(--danger); font-size: var(--fs-body-sm); overflow-wrap: anywhere; }
.ev__explain { padding: 0.5rem 0.6rem; border: 1px solid var(--border-hi); border-radius: var(--radius); background: var(--panel-alt); }
.ev__verdict { flex: none; width: 1.2ch; }
.ev__verdict--ran { color: var(--accent); }
.ev__verdict--mismatch { color: var(--fg-dim); }
.ev__verdict--lost_to_exclusive { color: var(--warn); }
</style>
