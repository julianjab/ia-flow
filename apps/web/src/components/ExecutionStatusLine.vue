<script setup lang="ts">
import type { ExecutionLog } from '@ia-flow/shared';
import { computed } from 'vue';

/**
 * La línea de estado de ejecución de una tarea — el vocabulario del handoff.
 *
 * Vive en `components/` y no en una feature porque la comparten `features/tasks`,
 * `features/statuses` y `features/executions`: una sola implementación del
 * vocabulario, o cada pantalla dice algo distinto sobre el mismo hecho.
 *
 * Orden de decisión, uno solo: corriendo → falló → terminó → bloqueada →
 * ignorada → sin ejecutar.
 */
const props = defineProps<{
  /** El ÚLTIMO run de la tarea. `null` = no corrió nunca. */
  execution?: ExecutionLog | null;
  /** Cuántas veces se despachó. Sólo se dice cuando es > 1: "1 intento" es ruido. */
  attempts?: number;
  /** Tiene dependencias sin cerrar. */
  blocked?: boolean;
  /** Texto de por qué ninguna regla la toma (sale de run-preview). */
  ignoredReason?: string | null;
  /**
   * ¿Sabemos si corrió?
   *
   * `false` (el default) mientras el agregado de runs no llegó. Sin esto, la
   * fila diría `○ sin ejecutar` sobre una tarea que sí corrió — un "no sé"
   * dibujado como "no hay", que es peor que el silencio.
   */
  runsKnown?: boolean;
  /** El provider modela PRs. Sin esto no se afirma `sin PR`. */
  pullRequestsKnown?: boolean;
  /** Hay un PR abierto para la tarea (para el `· PR abierto` del estado terminó). */
  hasOpenPr?: boolean;
}>();

type Kind = 'running' | 'failed' | 'done' | 'blocked' | 'ignored' | 'never' | 'unknown';

const kind = computed<Kind>(() => {
  const e = props.execution;
  if (e && !e.finishedAt) return 'running';
  if (e?.outcome === 'error') return 'failed';
  if (e) return 'done';
  if (props.blocked) return 'blocked';
  if (props.ignoredReason) return 'ignored';
  // Sin run y sin saber si hay runs: no se afirma nada.
  return props.runsKnown ? 'never' : 'unknown';
});

const GLYPH: Record<Kind, string> = {
  running: '◐',
  failed: '✕',
  done: '✓',
  blocked: '⛔',
  ignored: '○',
  never: '○',
  unknown: '',
};

/** `hace 2 h` — la edad es más útil que la fecha para "¿esto es de recién?". */
function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

function duration(e: ExecutionLog): string | null {
  const ms =
    e.durationMs ??
    (e.finishedAt ? new Date(e.finishedAt).getTime() - new Date(e.startedAt).getTime() : null);
  if (ms === null || Number.isNaN(ms) || ms < 0) return null;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

/** La duración de un run vivo sigue corriendo desde `startedAt`: congelarla
 *  haría parecer que el run se colgó. El tick lo trae `now` de afuera. */
function elapsed(e: ExecutionLog): string {
  const ms = Date.now() - new Date(e.startedAt).getTime();
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

/** Las partes de la línea, en el orden de lectura del handoff:
 *  glifo · qué pasó · agente · duración. */
const parts = computed<string[]>(() => {
  const e = props.execution;
  const out: string[] = [];
  switch (kind.value) {
    case 'running':
      // Sin `paso N/M`: el server todavía no guarda pasos dentro de un run, y
      // dibujarlos sería inventarlos (ver "Requisitos de backend" del handoff).
      out.push('corriendo', e!.agentId, elapsed(e!));
      break;
    case 'failed': {
      // Un ✕ nunca va sin el motivo al lado.
      const why = e!.failureClass ?? e!.stopReason ?? 'falló';
      out.push(`falló · ${why}`);
      const d = duration(e!);
      if (d) out.push(d);
      out.push(ago(e!.finishedAt ?? e!.startedAt));
      break;
    }
    case 'done': {
      out.push(`terminó ${ago(e!.finishedAt ?? e!.startedAt)}`.trim());
      if (props.hasOpenPr) out.push('PR abierto');
      const d = duration(e!);
      if (d) out.push(d);
      break;
    }
    case 'blocked':
      out.push('nunca se ejecutó', 'bloqueada');
      break;
    case 'ignored':
      out.push('ignorada', props.ignoredReason ?? '');
      break;
    case 'never':
      out.push('sin ejecutar');
      // `sin PR` sólo cuando el provider modela PRs: si no, es un "no sé".
      if (props.pullRequestsKnown && !props.hasOpenPr) out.push('sin PR');
      break;
    default:
      break;
  }
  if ((props.attempts ?? 0) > 1) out.push(`${props.attempts} intentos`);
  return out.filter(Boolean);
});
</script>

<template>
  <!-- `unknown` no se dibuja: el dato no llegó, y afirmar "sin ejecutar" sería
       mentir sobre una tarea que quizá corrió. -->
  <span v-if="kind !== 'unknown'" class="esl" :class="`esl--${kind}`">
    <span v-if="kind === 'running'" class="live-dot esl-live" aria-hidden="true"></span>
    <span v-else class="esl-glyph" aria-hidden="true">{{ GLYPH[kind] }}</span>
    <span class="esl-text">{{ parts.join(' · ') }}</span>
  </span>
</template>

<style scoped>
.esl {
  display: flex;
  align-items: baseline;
  gap: 0.35rem;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: var(--row-h);
  color: var(--fg-mute);
}
.esl-glyph {
  flex: 0 0 auto;
}
/* El punto vivo no comparte baseline con el texto: se alinea a mano contra la
   primera línea, como en el prototipo. */
.esl-live {
  flex: 0 0 auto;
  align-self: center;
}
/* Trunca la línea de estado, nunca el título: el final de un título es lo que
   distingue una fila de otra; el de la meta, no. */
.esl-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.esl--running { color: var(--accent); }
.esl--failed { color: var(--danger); }
.esl--done { color: var(--fg-mute); }
.esl--done .esl-glyph { color: var(--accent); }
.esl--blocked,
.esl--ignored { color: var(--warn); }
.esl--never { color: var(--fg-dimmer); }
</style>
