<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useActiveExecutionsStore } from '@/features/executions/activeStore';
import { useDispositionsStore } from '@/features/tasks/dispositionsStore';

/**
 * La navegación mobile: cuatro destinos al pie, en lugar del drawer.
 *
 * Cuatro es el techo con etiquetas legibles a 390px. Board no entra como quinto
 * —es la misma lista de tareas agrupada de otra forma— y pasa a ser un toggle
 * dentro de Tareas; el resto de la app (23 pantallas) vive en `Más`, que es el
 * cuarto tab y el único camino mobile a todas ellas.
 */
const props = defineProps<{
  /** Proyecto activo. Sin él los tres primeros tabs llevan al listado de
   *  proyectos: no hay a qué proyecto entrar todavía. */
  projectId: string | null;
}>();

const route = useRoute();
const activeExecutions = useActiveExecutionsStore();
/**
 * Lo que te espera, para el badge de Tareas (turno 8).
 *
 * Se pide una vez por proyecto y se cachea en el store: es el mismo dato que
 * la pantalla de Tareas usa, y `GET /api/tasks/dispositions` no es barato.
 * Sin `force`, entrar a Tareas después no vuelve a pagarlo.
 */
const dispositions = useDispositionsStore();
onMounted(() => void dispositions.fetch(props.projectId));
watch(() => props.projectId, (pid) => void dispositions.fetch(pid));

/**
 * Sin proyecto activo los tres primeros van al LISTADO, no a una URL armada.
 *
 * Concatenar el tab sobre `/projects` daba `/projects/tareas`, que el router
 * matchea como `projects/:id` y abre el detalle de un proyecto llamado
 * "tareas": pantalla vacía y fetches contra un id que no existe.
 */
const tabPath = (tab: string) =>
  props.projectId ? `/projects/${props.projectId}/${tab}` : '/projects';

/**
 * Dos señales, dos formas (turno 8): el **badge** cuenta lo que te espera y
 * pide una decisión; el **punto que late** dice que algo se mueve y no pide
 * nada. Nunca los dos en el mismo tab — un tab que grita dos cosas a la vez
 * no dice ninguna.
 *
 * El badge no se dibuja en cero ni mientras el dato no llegó: contar cero
 * sobre algo que no se sabe afirma "no te espera nada", que es lo contrario
 * de no saber.
 */
const waiting = computed(() =>
  dispositions.isLoaded(props.projectId) ? dispositions.waitingCount(props.projectId) : 0,
);

const TABS = computed(() => [
  // "Qué sigue" se fue: era la misma lista de Tareas con otro recorte, y dos
  // destinos para la misma pregunta hacían que el operador tuviera que decidir
  // por cuál entrar. Tareas ordena por disposición y trae los chips de corte
  // rápido, así que contesta lo mismo sin un destino aparte.
  { id: 'tareas', glyph: '▤', label: 'TAREAS', to: tabPath('tareas'), badge: waiting.value },
  { id: 'executions', glyph: '●', label: 'RUNS', to: tabPath('executions'), live: true },
  { id: 'mas', glyph: '☰', label: 'MÁS', to: '/mas' },
]);

/**
 * Qué tab está activo. Board cuenta como Tareas: es su otra vista, y dejar los
 * cuatro apagados mientras se mira el board haría parecer que el tab bar no
 * sabe dónde estás.
 */
const activeId = computed(() => {
  const path = route.path;
  if (path === '/mas') return 'mas';
  if (path.includes('/tareas') || path.includes('/board')) return 'tareas';
  if (path.includes('/executions')) return 'executions';
  return null;
});

/**
 * El badge de RUNS es un punto, no un número: el conteo ya está dentro de la
 * pantalla, y acá sólo importa el binario *hay algo corriendo / no hay*.
 *
 * Si el store nunca cargó, no se pinta — un punto quieto que insinúe actividad
 * sin saberlo es peor que ninguno.
 */
const hasRunning = computed(() => activeExecutions.loaded && activeExecutions.activeCount > 0);
</script>

<template>
  <nav class="tabbar" aria-label="Navegación principal">
    <RouterLink
      v-for="tab in TABS"
      :key="tab.id"
      class="tabbar__item"
      :class="{ 'is-active': activeId === tab.id }"
      :to="tab.to"
    >
      <span class="tabbar__glyph" aria-hidden="true">{{ tab.glyph }}</span>
      <span class="tabbar__label">{{ tab.label }}</span>
      <span
        v-if="tab.badge"
        class="tabbar__badge"
        :title="`${tab.badge} ${tab.badge === 1 ? 'tarea te espera' : 'tareas te esperan'}`"
      >{{ tab.badge }}</span>
      <span v-else-if="tab.live && hasRunning" class="tabbar__dot" aria-hidden="true"></span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.tabbar {
  display: grid;
  /* Una columna por tab, sean tres o cuatro: con `repeat(4, 1fr)` fijo, los
     tres destinos actuales ocupaban tres cuartos de la barra y el cuarto
     quedaba vacío contra el borde derecho. */
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  border-top: 1px solid var(--border);
  background: var(--panel);
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 60;
}
.tabbar__item {
  position: relative;
  height: 60px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--fg-dim);
  text-decoration: none;
}
/* Sin esto el `a:hover` global lo pinta de teal entero (trampa conocida). */
.tabbar__item:hover { background: transparent; color: var(--fg-mute); }
/* Barra superior de 2px, no un fondo relleno: a 60px de alto un bloque de
   color pesa demasiado y compite con el contenido. */
.tabbar__item.is-active {
  color: var(--accent);
  box-shadow: inset 0 2px 0 var(--accent);
}
.tabbar__item.is-active:hover { color: var(--accent); }
.tabbar__item.is-active .tabbar__label { font-weight: 700; }

/* El badge pide una decisión: --danger, con el número, arriba a la derecha del
   glifo — donde una app de teléfono lo pone. */
.tabbar__badge {
  position: absolute;
  top: 6px;
  left: 50%;
  margin-left: 0.4rem;
  min-width: 1.05rem;
  padding: 0 0.25rem;
  border-radius: 999px;
  background: var(--danger);
  color: var(--panel);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  font-weight: 700;
  line-height: 1.05rem;
  text-align: center;
}

.tabbar__glyph { font-size: 0.78rem; line-height: 1; }
.tabbar__label {
  font-family: var(--font-mono);
  font-size: 0.55rem;
  letter-spacing: 0.06em;
}
.tabbar__dot {
  position: absolute;
  top: 12px;
  left: calc(50% + 9px);
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: blink 1.6s ease-in-out infinite;
}
</style>
