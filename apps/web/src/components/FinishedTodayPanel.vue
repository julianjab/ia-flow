<script setup lang="ts">
import type { ExecutionLog } from '@ia-flow/shared';
import { computed, onMounted, ref, watch } from 'vue';
import { fetchExecutions } from '@/features/executions/api';
import { formatRelative } from '@/features/executions/relativeTime';

/**
 * Lo que terminó hoy — la mitad de abajo de la columna derecha de Qué sigue.
 *
 * Es el contrapeso de `RunningRunsPanel`: uno dice qué está pasando, éste dice
 * qué ya pasó. Los dos juntos contestan "¿en qué anduvo el pipeline hoy?" sin
 * salir de la pantalla, que es lo que el frame 3b busca — la cola y lo que
 * corre, en la misma vista.
 *
 * Va **plegado por lo que no hay que mirar**: los éxitos son una línea cada
 * uno, y lo que falló va primero y en `--danger`. Un run que salió bien no
 * pide nada; uno que falló hoy y nadie tocó, sí (O4).
 *
 * Vive en `components/` porque lo usa una feature que no es la suya —
 * `features/tasks` no puede importar de `features/executions`.
 */
const props = defineProps<{
  /** `null` = todas las del server. */
  projectId: string | null;
  /** Cuántas listar. El resto se ve en Ejecuciones. */
  limit?: number;
}>();

const emit = defineEmits<{ open: [runId: string] }>();

const runs = ref<ExecutionLog[]>([]);
const loading = ref(false);
/** No se pudo consultar. NO es "no terminó nada": el panel se calla en vez de
 *  afirmar un cero que no comprobó. */
const failed = ref(false);

async function load() {
  loading.value = true;
  failed.value = false;
  const pid = props.projectId;
  try {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const next = await fetchExecutions({
      ...(pid ? { projectId: pid } : {}),
      from: from.toISOString(),
      limit: props.limit ?? 12,
    });
    if (props.projectId !== pid) return;
    // Sólo lo TERMINADO: lo que sigue corriendo es del panel de arriba, y
    // repetirlo acá sería la misma fila dos veces en la misma columna.
    runs.value = next.filter((e) => e.finishedAt);
  } catch {
    if (props.projectId !== pid) return;
    failed.value = true;
    runs.value = [];
  } finally {
    if (props.projectId === pid) loading.value = false;
  }
}

onMounted(load);
watch(() => props.projectId, load);

defineExpose({ reload: load });

/** Lo que falló primero: es lo único de esta lista que puede pedir algo. */
const ordered = computed(() =>
  [...runs.value].sort((a, b) => {
    const bad = (e: ExecutionLog) => (e.outcome === 'success' ? 1 : 0);
    if (bad(a) !== bad(b)) return bad(a) - bad(b);
    return (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '');
  }),
);

function glyph(run: ExecutionLog): string {
  if (run.outcome === 'success') return '✓';
  if (run.outcome === 'error') return '✕';
  return '⊘';
}

/** Qué pasó, en las menos palabras posibles. El detalle vive en Ejecuciones. */
function line(run: ExecutionLog): string {
  const issue = run.taskId.startsWith('I_') ? null : run.taskId;
  const what =
    run.outcome === 'success'
      ? 'terminó'
      : (run.failureClass ?? run.outcome ?? 'sin resultado');
  return [issue, what].filter(Boolean).join(' ');
}
</script>

<template>
  <section v-if="!failed && (loading || ordered.length)" class="ft-panel">
    <header class="ft-panel__head">
      <span class="uc-label">Terminados hoy</span>
      <span class="ft-panel__count">{{ ordered.length }}</span>
    </header>

    <p v-if="loading && !ordered.length" class="ft-panel__empty">Cargando…</p>

    <ul v-else class="ft-panel__list">
      <li v-for="run in ordered" :key="run.id">
        <button
          type="button"
          class="ft-row"
          :class="{ 'ft-row--bad': run.outcome !== 'success' }"
          @click="emit('open', run.id)"
        >
          <span class="ft-row__glyph" aria-hidden="true">{{ glyph(run) }}</span>
          <span class="ft-row__text" :title="run.taskTitle">{{ line(run) }}</span>
          <span class="ft-row__when">{{ run.finishedAt ? formatRelative(run.finishedAt) : '' }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.ft-panel {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  overflow: clip;
}
.ft-panel__head {
  display: flex;
  align-items: center;
  gap: 0.5ch;
  height: 26px;
  padding: 0 0.7rem;
  background: var(--panel-hi);
  border-bottom: 1px solid var(--border);
}
.ft-panel__count { color: var(--fg-dimmer); font-family: var(--font-mono); font-size: var(--fs-micro); }
.ft-panel__empty { margin: 0; padding: 0.5rem 0.7rem; font-size: var(--fs-micro); color: var(--fg-dim); }

.ft-panel__list { list-style: none; margin: 0; padding: 0; }
.ft-row {
  display: flex;
  align-items: center;
  gap: 0.6ch;
  width: 100%;
  /* Se toca (abre el run), así que --tap-h. Es una lista corta: acá el alto no
     compite con nada. */
  min-height: var(--tap-h);
  padding: 0 0.7rem;
  border: none;
  background: none;
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  text-align: left;
  cursor: pointer;
}
.ft-row:hover { background: var(--panel-hi); color: var(--fg); }
.ft-row + .ft-row { border-top: 1px solid var(--border-mute); }
.ft-row__glyph { flex: 0 0 auto; color: var(--accent); }
.ft-row--bad .ft-row__glyph { color: var(--danger); }
.ft-row__text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ft-row__when { flex: 0 0 auto; color: var(--fg-dimmer); }
</style>
