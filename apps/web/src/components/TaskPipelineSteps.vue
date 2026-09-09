<script setup lang="ts">
import type { ExecutionLog } from '@ia-flow/shared';
import { computed } from 'vue';

const props = defineProps<{
  /** El pipeline en orden — mismo `statusOptions` que arma `boardColumns` en
   *  TareasSection.vue: el orden lo da la fuente, no un valor propio de acá. */
  statuses: string[];
  /** Status actual de la tarea. Case-insensitive contra `statuses`, mismo
   *  criterio que `boardColumns`/`terminalStatus`. */
  currentStatus?: string | null;
  /** Ya ordenadas por `fetchTaskExecutions` (más reciente primero). */
  executions: ExecutionLog[];
}>();

type StepGlyphState = 'success' | 'error' | 'cancelled' | 'truncated' | 'running' | 'current' | 'pending';

interface Step {
  name: string;
  state: StepGlyphState;
  /** Última ejecución que pasó por este status, si hubo alguna — para el
   *  tooltip (quién, cuándo). */
  execution: ExecutionLog | null;
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

const steps = computed<Step[]>(() => {
  // Nada de inferir "hecho" por posición: un status ANTES del actual en el
  // pipeline no implica que la tarea haya pasado por ahí — una regla puede
  // saltarlo entero (de `draft` directo a `refine`, sin pasar por `merge`).
  // Sólo se pinta lo que una ejecución de verdad evidencia.
  return props.statuses.map((name) => {
    // La ejecución más reciente que arrancó con este status como
    // `initialStatus` — es la única pista que una fila deja de "por dónde
    // pasó", ya que no hay un status "resultante" persistido por run.
    const execution = props.executions.find((e) => norm(e.initialStatus) === norm(name)) ?? null;
    let state: StepGlyphState;
    if (execution && !execution.finishedAt) state = 'running';
    else if (execution) state = (execution.outcome ?? 'pending') as StepGlyphState;
    else if (norm(name) === norm(props.currentStatus)) state = 'current';
    else state = 'pending';
    return { name, state, execution };
  });
});

function glyphOf(state: StepGlyphState): string {
  if (state === 'success') return '✓';
  if (state === 'error') return '✕';
  if (state === 'cancelled' || state === 'truncated') return '–';
  if (state === 'running') return '◐';
  return '';
}

function titleOf(step: Step): string {
  const e = step.execution;
  if (!e) return step.name;
  const outcome = e.finishedAt ? (e.outcome ?? 'sin outcome') : 'corriendo';
  return `${step.name} — ${e.agentId} (${outcome})`;
}
</script>

<template>
  <ol v-if="statuses.length" class="pipe-steps" role="list">
    <li v-for="step in steps" :key="step.name" class="pipe-step" :title="titleOf(step)">
      <span class="pipe-dot" :class="`is-${step.state}`">{{ glyphOf(step.state) }}</span>
      <span class="pipe-label" :class="{ 'is-current': step.state === 'current' }">{{ step.name }}</span>
    </li>
  </ol>
</template>

<style scoped>
/* Wide content scrollea en su propia caja, nunca en la página (R del design
 * system) — un pipeline de 6+ statuses no entra en los 400px del panel. */
.pipe-steps {
  display: flex;
  align-items: center;
  list-style: none;
  margin: 0;
  padding: 0.1rem 0 0.3rem;
  overflow-x: auto;
}
.pipe-step {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}
/* La línea conecta un paso con el siguiente, no antes del primero. */
.pipe-step + .pipe-step::before {
  content: '';
  display: block;
  width: 1.1rem;
  height: 1px;
  background: var(--border);
  margin: 0 0.3rem;
}
.pipe-dot {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 1.1rem;
  height: 1.1rem;
  border-radius: 50%;
  border: 1px solid var(--border-hi);
  font-size: var(--fs-micro);
  line-height: 1;
  color: var(--fg-dim);
}
.pipe-dot.is-current {
  border-color: var(--info);
  color: var(--info);
}
.pipe-dot.is-success {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--panel);
}
.pipe-dot.is-error {
  border-color: var(--danger);
  background: var(--danger);
  color: var(--panel);
}
.pipe-dot.is-cancelled,
.pipe-dot.is-truncated {
  border-color: var(--warn);
  background: var(--warn);
  color: var(--panel);
}
.pipe-dot.is-running {
  border-color: var(--info);
  color: var(--info);
}
.pipe-label {
  margin-left: 0.3rem;
  flex: 0 0 auto;
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  white-space: nowrap;
}
.pipe-label.is-current { color: var(--fg); font-weight: 600; }
</style>
