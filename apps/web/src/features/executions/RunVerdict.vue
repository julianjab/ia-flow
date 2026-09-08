<script setup lang="ts">
import type { ExecutionLog } from '@ia-flow/shared';
import { computed } from 'vue';
import { useNow } from '@/composables/useNow';
import { CLASS_LABELS } from './health-format';

/**
 * El detalle de un run, bandas 2 y 3 del turno 6: **veredicto y causa**.
 *
 * Un run se abre cuando la fila del bucket 1 no se explica sola, así que lo
 * primero de la pantalla es qué pasó y por qué — no una tabla de veinte campos
 * donde el error es la fila catorce. El veredicto son cuatro datos (glifo,
 * outcome, duración, título) más tres de contexto; la causa es el error
 * LITERAL, copiable entero, y qué se hace con él.
 *
 * **R13 · un dato que el server no tiene no se dibuja.** Por eso acá no hay
 * timeline ni `paso 3/5` (`execution_logs` guarda una fila por run, no pasos),
 * ni `intento 2 de 2` (nadie cuenta los intentos), ni el p50 del agente (las
 * stats traen promedio y p95, no mediana — así que la comparación dice
 * «promedio», que es lo que se está midiendo). La banda entera se omite cuando
 * no hay nada que decir; no se rellena con un placeholder.
 */
const props = defineProps<{
  execution: ExecutionLog;
  /** El issue en el provider: el título es link cuando existe. */
  issueUrl?: string | null;
  /**
   * Duración promedio de ESTE agente en la ventana, para el aviso de lentitud
   * de un run vivo. Sin dato, no hay aviso (R13).
   */
  avgDurationMs?: number | null;
  /** El pipeline del proyecto — donde se agrega la regla que falta. */
  rulesHref?: string | null;
}>();

const emit = defineEmits<{ copyError: [] }>();

// Un run vivo tiene que ver correr su duración: congelarla haría parecer que
// se colgó.
const { now } = useNow();

const running = computed(() => !props.execution.finishedAt);

/** El veredicto en una palabra. Es el mismo vocabulario de la lista, dicho en
 *  grande: `falló`, `abortado`, `cortado`, `terminó`, `corriendo`. */
const verdict = computed<{ glyph: string; label: string; tone: string }>(() => {
  const e = props.execution;
  if (running.value) return { glyph: '', label: 'corriendo', tone: 'running' };
  switch (e.outcome) {
    case 'error':
      return { glyph: '✕', label: 'falló', tone: 'failed' };
    case 'cancelled':
      return { glyph: '⊘', label: 'abortado a mano', tone: 'stopped' };
    case 'truncated':
      return { glyph: '⊘', label: 'cortado', tone: 'stopped' };
    case 'success':
      return { glyph: '✓', label: 'terminó', tone: 'done' };
    default:
      // Terminó sin outcome: la fila existe y no dice cómo cerró. Decir
      // `terminó` sería afirmar que salió bien.
      return { glyph: '○', label: 'sin resultado', tone: 'unknown' };
  }
});

function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const elapsedMs = computed<number | null>(() => {
  const e = props.execution;
  const start = new Date(e.startedAt).getTime();
  const end = e.finishedAt ? new Date(e.finishedAt).getTime() : now.value;
  const ms = e.durationMs ?? end - start;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
});

const duration = computed(() => (elapsedMs.value === null ? '—' : fmtDuration(elapsedMs.value)));

/** `implementer · anthropic-api · sonnet` — sin los campos que no vinieron. */
const identity = computed(() =>
  [props.execution.agentId, props.execution.providerId, props.execution.model]
    .filter(Boolean)
    .join(' · '),
);

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hour12: false });
}

const timing = computed(() =>
  running.value
    ? `arrancó ${clock(props.execution.startedAt)} · sigue vivo`
    : `arrancó ${clock(props.execution.startedAt)} · terminó ${clock(props.execution.finishedAt as string)}`,
);

/**
 * «lleva 6× el promedio de este agente (6m 20s)».
 *
 * Sólo mientras corre y sólo desde 2×: por debajo de eso la comparación no
 * dice nada —un run puede tardar el doble por el tamaño del issue— y avisar
 * siempre enseña a ignorar el aviso.
 */
const slowNote = computed<string | null>(() => {
  if (!running.value) return null;
  const avg = props.avgDurationMs;
  const ms = elapsedMs.value;
  if (!avg || avg <= 0 || ms === null) return null;
  const factor = ms / avg;
  if (factor < 2) return null;
  return `lleva ${Math.round(factor)}× el promedio de este agente (${fmtDuration(avg)})`;
});

/**
 * Lo que rompió, en una línea: `tools fallando · pytest exit 1`.
 *
 * La clase pasa por `CLASS_LABELS` —el mismo diccionario que usa el veredicto
 * de agentes— porque el valor crudo de la peor de todas es `unknown`, que
 * dicho así parece un bug de la UI en vez de lo que es: el server no pudo
 * clasificar el fallo. El `stopReason` va literal: ahí sí, el texto del
 * proveedor es el dato.
 */
const causeHeadline = computed(() => {
  const cls = props.execution.failureClass;
  return [cls ? (CLASS_LABELS[cls] ?? cls) : null, props.execution.stopReason]
    .filter(Boolean)
    .join(' · ');
});

/**
 * La banda de causa existe sólo cuando falló y hay algo literal que mostrar.
 * Un `success` no tiene causa, y un fallo sin `errorMsg` ni clase no tiene qué
 * decir: una banda vacía con el título «qué salió mal» promete una respuesta
 * que no está.
 */
const hasCause = computed(
  () =>
    props.execution.outcome !== 'success' &&
    !running.value &&
    !!(props.execution.errorMsg || causeHeadline.value),
);
</script>

<template>
  <!-- Banda 2 · veredicto -->
  <section class="rv" :class="`rv--${verdict.tone}`" data-testid="run-verdict">
    <p class="rv__headline">
      <span v-if="running" class="live-dot rv__live" aria-hidden="true"></span>
      <span v-else class="rv__glyph" aria-hidden="true">{{ verdict.glyph }}</span>
      <span class="rv__label">{{ verdict.label }}</span>
      <span class="rv__dur">{{ duration }}</span>
    </p>

    <p class="rv__task">
      <a v-if="issueUrl" :href="issueUrl" target="_blank" rel="noopener noreferrer"
        >{{ execution.taskTitle }} ↗</a
      >
      <template v-else>{{ execution.taskTitle }}</template>
    </p>

    <p class="rv__meta">
      <span v-if="identity">{{ identity }}</span>
      <span>{{ timing }}</span>
      <span v-if="slowNote" class="rv__slow" data-testid="run-verdict-slow">{{ slowNote }}</span>
    </p>
  </section>

  <!-- Banda 3 · causa. El error, no un resumen del error: texto literal, la
       clase que lo agrupa, y a dónde se va a arreglar. -->
  <section v-if="hasCause" class="rc" data-testid="run-cause">
    <p class="rc__title">qué salió mal</p>
    <p v-if="causeHeadline" class="rc__headline">{{ causeHeadline }}</p>
    <pre v-if="execution.errorMsg" class="rc__raw">{{ execution.errorMsg }}</pre>
    <p class="rc__why">
      Quedó en <strong>te espera</strong>: nadie retoma este run solo — lo mueve una regla del
      pipeline, o vos.
    </p>
    <div class="rc__actions">
      <button
        v-if="execution.errorMsg"
        type="button"
        class="rc__action"
        data-testid="run-cause-copy"
        @click="emit('copyError')"
      >copiar el error</button>
      <RouterLink v-if="rulesHref" class="rc__action" :to="rulesHref" data-testid="run-cause-rules">
        ver el pipeline ↗
      </RouterLink>
    </div>
  </section>
</template>

<style scoped>
/* ── Banda 2 · veredicto ─────────────────────────────────────────────────── */
.rv {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.75rem 0;
}
.rv__headline {
  display: flex;
  align-items: baseline;
  gap: 0.6ch;
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-body);
  color: var(--fg-mute);
}
.rv__glyph,
.rv__live { flex: 0 0 auto; }
.rv__live { align-self: center; }
.rv__label { font-weight: 700; }
/* La duración cierra la línea: es el otro dato que se mira de un vistazo. */
.rv__dur { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--fg-dim); }

.rv--failed .rv__glyph,
.rv--failed .rv__label { color: var(--danger); }
.rv--stopped .rv__glyph,
.rv--stopped .rv__label { color: var(--warn); }
.rv--done .rv__glyph,
.rv--done .rv__label { color: var(--accent); }
.rv--running .rv__label { color: var(--accent); }
.rv--unknown .rv__label { color: var(--fg-dim); }

.rv__task {
  margin: 0;
  font-size: var(--fs-body);
  line-height: 1.4;
  color: var(--fg);
  text-wrap: pretty;
  overflow-wrap: anywhere;
}
.rv__task a { color: var(--fg); text-decoration: none; }
.rv__task a:hover { background: transparent; text-decoration: underline; }

.rv__meta {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  overflow-wrap: anywhere;
}
.rv__slow { color: var(--warn); }

/* ── Banda 3 · causa ─────────────────────────────────────────────────────── */
.rc {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--danger);
  border-left-width: 3px;
  border-radius: var(--radius-sm);
  background: var(--red-bg);
}
.rc__title {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dim);
}
.rc__headline {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  color: var(--danger);
  overflow-wrap: anywhere;
}
/* El error, entero y copiable. Envuelve en vez de scrollear de lado: en 390px
   un `pre` que scrollea esconde justo la línea que explica el fallo (R2). */
.rc__raw {
  margin: 0;
  max-height: 14rem;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: 1.5;
  color: var(--fg-mute);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.rc__why {
  margin: 0;
  font-size: var(--fs-micro);
  line-height: 1.5;
  color: var(--fg-dim);
}
.rc__why strong { color: var(--danger); font-weight: 600; }

.rc__actions { display: flex; flex-wrap: wrap; gap: 0.75rem; }
.rc__action {
  display: inline-flex;
  align-items: center;
  /* Se toca: --tap-h de área (R1), sin caja propia — son enlaces, no botones
     que compitan con la barra de acciones de abajo. */
  min-height: var(--tap-h);
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  text-decoration: none;
  cursor: pointer;
}
.rc__action:hover { background: transparent; text-decoration: underline; }
</style>
