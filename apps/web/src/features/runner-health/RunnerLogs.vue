<script setup lang="ts">
import type { RunnerLogLine } from '@ia-flow/shared';
import { computed, ref } from 'vue';
import { extractErrorMessage } from '@/composables/extractErrorMessage';
import { getLogs } from '@/features/runner-health/api';
import {
  appendLines,
  clockOf,
  copyText,
  LOG_FILTERS,
  type LogFilter,
  levelOf,
  MAX_LINES,
} from '@/features/runner-health/logs';
import { usePoll } from '@/features/runner-health/usePoll';
import CopyButton from '@/ui/CopyButton.vue';
import LogLine from '@/ui/LogLine.vue';

// «Logs del server»: el log del proceso del runner (`GET /api/logs`), como en el menú de Mac. Todo,
// Avisos o Errores; se relee cada 3 s mientras está abierta, pidiendo sólo lo nuevo (`after`), y
// guarda las últimas 500. Lo más nuevo arriba. «Copiar» copia lo que se ve, como lo imprime el proceso.

const POLL_MS = 3000;

const filter = ref<LogFilter>('all');
const lines = ref<RunnerLogLine[]>([]);
const lastSeq = ref(0);
const loaded = ref(false);
const error = ref<string | null>(null);
/** El runner no expone `/api/logs` (es anterior). */
const unsupported = ref(false);

async function tick() {
  const asked = filter.value;
  const after = lastSeq.value;
  try {
    const page = await getLogs({ level: levelOf(asked), after, limit: MAX_LINES });
    // Cambió el filtro mientras volaba: lo que llegó es de otro.
    if (asked !== filter.value || after !== lastSeq.value) return;
    if (!page) {
      unsupported.value = true;
      return;
    }
    unsupported.value = false;
    lines.value = appendLines(lines.value, page.lines);
    lastSeq.value = page.last_seq;
    error.value = null;
  } catch (err) {
    if (asked === filter.value) error.value = extractErrorMessage(err);
  } finally {
    if (asked === filter.value) loaded.value = true;
  }
}

const poll = usePoll(tick, POLL_MS);

function choose(next: LogFilter) {
  if (next === filter.value) return;
  filter.value = next;
  lines.value = [];
  lastSeq.value = 0;
  loaded.value = false;
  error.value = null;
  void tick();
}

const newestFirst = computed(() => [...lines.value].reverse());
const text = computed(() => copyText(lines.value));
</script>

<template>
  <div class="rl">
    <nav class="seg" aria-label="Nivel">
      <button
        v-for="f in LOG_FILTERS"
        :key="f.id"
        type="button"
        class="seg__btn"
        :aria-pressed="filter === f.id"
        :data-test="`filter-${f.id}`"
        @click="choose(f.id)"
      >{{ f.label }}</button>
    </nav>

    <div v-if="unsupported" class="rl__note" role="status" data-test="unsupported">
      Este runner todavía no expone <span class="mono">/api/logs</span>: actualizalo para ver su log.
    </div>
    <div v-else-if="error" class="rl__err" role="alert">
      <p>✕ No se pudo leer el log: {{ error }}</p>
      <button type="button" class="btn" @click="poll.now()">Reintentar</button>
    </div>

    <div v-if="!loaded && !unsupported" class="rl__logs" aria-busy="true">
      <span class="sr-only">Cargando logs…</span>
      <span v-for="i in 6" :key="i" class="skeleton rl__sk" aria-hidden="true" />
    </div>
    <p v-else-if="loaded && !lines.length && !unsupported && !error" class="rl__empty" data-test="empty">Sin líneas todavía.</p>
    <div v-else-if="lines.length" class="rl__logs" data-test="lines">
      <LogLine
        v-for="line in newestFirst"
        :key="line.seq"
        :time="clockOf(line.time)"
        :level="line.level"
        :origin="line.scope"
        :message="line.fields ? `${line.message}  ${line.fields}` : line.message"
      />
    </div>

    <footer v-if="!unsupported" class="rl__foot">
      <span class="rl__count">{{ loaded ? `${lines.length} ${lines.length === 1 ? 'línea' : 'líneas'} · se actualiza cada 3 s` : 'Cargando…' }}</span>
      <CopyButton v-if="lines.length" :value="text" label="el log" class="rl__copy" data-test="copy">
        <template #default="{ copied }">{{ copied ? '✓ Copiado' : 'Copiar' }}</template>
      </CopyButton>
    </footer>
  </div>
</template>

<style scoped>
.rl { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; }
.rl__note { padding: 0.75rem 1rem; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--panel-alt); color: var(--fg-mute); }
.rl__err { display: flex; flex-direction: column; align-items: flex-start; gap: 0.35rem; padding: 0.75rem 1rem; border: 1px solid var(--danger); border-radius: var(--radius-lg); background: var(--red-bg); }
.rl__err p { margin: 0; color: var(--danger); overflow-wrap: anywhere; }
.rl__logs { display: flex; flex-direction: column; gap: 2px; padding: 0.5rem 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg); min-width: 0; }
.rl__sk { margin: 0 0.5rem; }
.rl__empty { margin: 0; color: var(--fg-dim); }
.rl__foot { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.rl__count { min-width: 0; color: var(--fg-dim); font-size: var(--fs-chrome); }
/* «Copiar» con la caja de `.btn`: `CopyButton` trae la del glifo suelto. */
.rl__foot .rl__copy { flex: none; min-height: var(--tap-h); padding: 0 1rem; border: 1px solid var(--border-hi); border-radius: var(--radius); background: var(--panel-hi); color: var(--fg-mute); font: 500 var(--fs-body-sm) var(--font-body); }
.rl__foot .rl__copy:hover { background: var(--panel-alt); color: var(--fg); }
</style>
