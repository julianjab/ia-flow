<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';

/**
 * `Lista / Board` — las dos vistas de las mismas tareas.
 *
 * Board dejó de ser un destino propio de la navegación mobile: cuatro tabs es
 * el techo con etiquetas legibles a 390px, y el quinto habría entrado a costa
 * de abreviar. Board es la misma lista agrupada de otra forma, así que su
 * lugar natural es acá adentro. La ruta `/projects/:id/board` sigue siendo
 * válida — el toggle navega a ella.
 *
 * Vive en `components/` y no en una feature porque lo comparten dos:
 * `features/tasks` y `features/statuses`. Un import entre features sería la
 * otra opción, y es justo lo que el CLAUDE.md del repo prohíbe.
 */
const props = withDefaults(
  defineProps<{
  projectId: string | null;
  /** Cuál de las dos está abierta. */
  view: 'lista' | 'board';
  /**
   * ¿El proyecto tiene statuses?
   *
   * Un pipeline puramente label/when-driven devuelve cero, y su board queda
   * vacío — el sidebar de desktop ya esconde ese tab por eso mismo
   * (`activeProjectHasStatuses` en AppShell). En mobile este toggle es el
   * ÚNICO camino al board, así que ofrecerlo igual mandaría a una pantalla
   * vacía sin nada que explique por qué.
   */
  boardAvailable?: boolean;
  }>(),
  // Vue castea los props Boolean: sin default explícito, "ausente" llega como
  // `false` y el toggle desaparecía en todos lados.
  { boardAvailable: true },
);

const router = useRouter();

const targets = computed(() => ({
  lista: `/projects/${props.projectId}/tareas`,
  board: `/projects/${props.projectId}/board`,
}));

function go(view: 'lista' | 'board') {
  if (view === props.view || !props.projectId) return;
  void router.push(targets.value[view]);
}
</script>

<template>
  <div v-if="projectId && boardAvailable" class="lbt" role="tablist" aria-label="Vista de tareas">
    <button
      type="button"
      class="lbt__opt"
      :class="{ 'is-active': view === 'lista' }"
      role="tab"
      :aria-selected="view === 'lista'"
      @click="go('lista')"
    >Lista</button>
    <button
      type="button"
      class="lbt__opt"
      :class="{ 'is-active': view === 'board' }"
      role="tab"
      :aria-selected="view === 'board'"
      @click="go('board')"
    >Board</button>
  </div>
</template>

<style scoped>
.lbt { display: flex; gap: 0.25rem; }
.lbt__opt {
  flex: 1;
  /* 40px: la altura de un control táctil de filtro. */
  height: 40px;
  border: 1px solid var(--border-hi);
  border-radius: var(--radius-sm);
  background: var(--panel-hi);
  color: var(--fg-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-chrome);
  cursor: pointer;
}
/* Video inverso para la activa, como toda selección del sistema. */
.lbt__opt.is-active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--panel);
  font-weight: 700;
}

/* En desktop el segmentado no compite con el sidebar, que ya tiene las dos
   entradas: se achica a un control de chrome. */
@media (min-width: 768px) {
  .lbt { align-self: flex-start; }
  .lbt__opt { height: var(--chrome-h); min-width: 8ch; }
}
</style>
