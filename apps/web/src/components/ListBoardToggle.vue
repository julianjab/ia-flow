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
const props = defineProps<{
  projectId: string | null;
  /** Cuál de las dos está abierta. */
  view: 'lista' | 'board';
}>();

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
  <div v-if="projectId" class="lbt" role="tablist" aria-label="Vista de tareas">
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
