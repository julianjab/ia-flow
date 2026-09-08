<script setup lang="ts">
import type { TaskFocus } from '@ia-flow/shared';
import { computed, ref, watch } from 'vue';

/**
 * El foco: qué mirar primero de lo que el orden ya ordenó.
 *
 * Va entre el chrome de Tareas y el primer bucket. Dos reglas la gobiernan y
 * ninguna es cosmética:
 *
 * **R16 · lo inferido no usa la voz de lo calculado.** Magenta y `✦` sólo para
 * lo que salió del modelo, ningún color de estado en un texto inferido (el
 * `why` va siempre en `--fg-mute`, nunca en `--danger` como la razón de la
 * fila que está cuatro líneas abajo), y la hora en que se pensó — porque el
 * resultado se cachea y puede estar hablando de una lista que ya cambió.
 *
 * **R17 · un resumen señala; no actúa.** Tocar un pick lleva a la fila y nada
 * más. El verbo (`Reintentar`, `Revisar el PR`) ya vive ahí, a lo ancho, con
 * su destino real; duplicarlo acá sería mantener dos caminos para cada acción
 * y darle al modelo un botón.
 */
const props = defineProps<{
  /** Para persistir el colapso por proyecto, y para el `reintentar`. */
  projectId: string | null;
  focus: TaskFocus | null;
  loading: boolean;
  failed: boolean;
  /** Cuántas filas te esperan. Lo dice el estado de carga y el degradado: es
   *  lo que sigue siendo cierto mientras el foco no llega. */
  waitingCount: number;
  /**
   * El título de cada tarea, por id.
   *
   * Lo pasa la pantalla y no viaja en el foco: el modelo elige ENTRE las filas
   * que ya están dibujadas, así que el título ya está en memoria. Mandarlo de
   * vuelta desde el server sería una segunda copia que puede discrepar de la
   * fila que está cuatro líneas abajo.
   */
  titles: Record<string, string>;
  /**
   * Arriba de la card ya hay algo pidiendo atención (el aviso de reorden).
   *
   * Se dibuja colapsada aunque el usuario la haya dejado abierta, y **sin**
   * tocar su preferencia guardada: cuando el aviso se va, vuelve como estaba.
   * Dos bloques expandidos entre el chrome y la primera fila la empujan fuera
   * de la pantalla, que es lo que el tope duro existe para evitar.
   */
  crowded?: boolean;
}>();

const emit = defineEmits<{
  /** Ir a la fila de esta tarea. Quien la tiene es la pantalla, no la card. */
  (e: 'go', taskId: string): void;
  (e: 'retry'): void;
}>();

/**
 * Colapsada es el default a partir de la segunda visita.
 *
 * La primera abre expandida —si no, nadie descubre que hay algo adentro— y
 * después queda como la dejaste. Un headline nuevo **no** la reabre solo:
 * nada que el modelo decida se queda con la pantalla.
 */
const STORAGE_PREFIX = 'focus.open.';
const open = ref(true);

function readOpen(projectId: string | null): boolean {
  if (!projectId) return true;
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + projectId);
    return raw === null ? true : raw === '1';
  } catch {
    // Modo privado, o el navegador bloqueando storage. Abierta es el default
    // de una primera visita, que es exactamente lo que esto es.
    return true;
  }
}

watch(() => props.projectId, (id) => { open.value = readOpen(id); }, { immediate: true });

function setOpen(next: boolean): void {
  open.value = next;
  if (!props.projectId) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + props.projectId, next ? '1' : '0');
  } catch {
    // El colapso es una conveniencia, no estado que haya que garantizar.
  }
}

/**
 * Tocar un pick cierra la card.
 *
 * Efecto secundario deliberado: llegás a la fila con la lista entera abajo, no
 * con media pantalla de resumen arriba tapándola.
 */
function goTo(taskId: string): void {
  setOpen(false);
  emit('go', taskId);
}

const EFFORT_LABEL: Record<string, string> = { quick: 'rápido', deep: 'profundo' };

/** Cuándo se pensó, en la escala en que importa: si dice minutos, es de ahora.
 *  Un timestamp exacto arriba de una lista sería ruido. */
const age = computed(() => {
  if (!props.focus) return '';
  const ms = Date.now() - new Date(props.focus.computedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.floor(h / 24)} d`;
});

/** Lo que se dibuja, que no es lo que el usuario eligió: ver `crowded`. */
const expanded = computed(() => open.value && !props.crowded);

const rowsLabel = computed(() =>
  props.waitingCount === 1 ? '1 fila' : `${props.waitingCount} filas`,
);
</script>

<template>
  <!-- Cargando: UNA línea, nunca un esqueleto de la card expandida. Reservar
       alto para algo que puede no llegar mueve la lista dos veces. -->
  <div v-if="loading && !focus && !failed" class="fc fc--thin" data-testid="focus-loading">
    <span class="fc__glyph">✦</span>
    <span class="fc__thin-text">leyendo las {{ rowsLabel }}</span>
  </div>

  <!-- Degradado. Dos líneas: qué falló y qué sigue siendo cierto. Sin rojo —
       el rojo es de lo que te espera, y una inferencia que no salió no te
       espera. La caja entera es el reintentar, un solo blanco táctil. -->
  <button
    v-else-if="failed"
    type="button"
    class="fc fc--failed"
    data-testid="focus-failed"
    @click="emit('retry')"
  >
    <span class="fc__glyph">✦</span>
    <span class="fc__failed-text">
      <span class="fc__failed-what">no se pudo calcular el foco</span>
      <span class="fc__failed-still">las {{ rowsLabel }} están completas y ordenadas</span>
    </span>
    <span class="fc__retry">reintentar</span>
  </button>

  <!-- Sin foco no se dibuja NADA: ni hueco, ni card vacía, ni un cartel que
       diga que no hay nada. El primer encabezado de bucket ya lo dice todo. -->
  <section v-else-if="focus" class="fc fc--card" data-testid="focus-card">
    <button
      type="button"
      class="fc__head"
      :aria-expanded="expanded"
      data-testid="focus-toggle"
      @click="setOpen(!open)"
    >
      <span class="fc__head-text">
        <span class="fc__kicker">
          <span class="fc__glyph">✦</span> foco · inferido
          <span v-if="age" class="fc__age">· {{ age }}</span>
        </span>
        <span class="fc__headline" :class="{ 'is-clamped': !expanded }">{{ focus.headline }}</span>
      </span>
      <span class="fc__chev">{{ expanded ? '⌃' : '⌄' }}</span>
    </button>

    <template v-if="expanded">
      <button
        v-for="pick in focus.picks"
        :key="pick.taskId"
        type="button"
        class="fc__pick"
        :data-testid="`focus-pick-${pick.taskId}`"
        @click="goTo(pick.taskId)"
      >
        <span class="fc__glyph">✦</span>
        <span class="fc__pick-body">
          <span class="fc__pick-top">
            <span class="fc__pick-title">{{ titles[pick.taskId] ?? pick.taskId }}</span>
            <span class="fc__effort">{{ EFFORT_LABEL[pick.effort] ?? pick.effort }}</span>
          </span>
          <!-- El `why` en `--fg-mute` SIEMPRE (R16): es lo que lo separa a
               simple vista de la razón calculada de la fila de abajo. -->
          <span class="fc__why">{{ pick.why }}</span>
        </span>
      </button>

      <!-- Los clusters son texto, no botones: filtrar por un conjunto de ids
           es `FilterByIds`, que está pedido y sin aprobar en DESIGN_SYSTEM.md.
           Una fila que parece tocable y no hace nada es peor que una que no lo
           parece — los `taskIds` ya viajan para el día que se apruebe. -->
      <p
        v-for="cluster in focus.clusters"
        :key="cluster.label"
        class="fc__cluster"
        data-testid="focus-cluster"
      >
        <span class="fc__glyph">✦</span>
        <span class="fc__cluster-label">{{ cluster.label }}</span>
        <span class="fc__cluster-count">{{ cluster.taskIds.length }} tareas</span>
      </p>
    </template>
  </section>
</template>

<style scoped>
/* El borde izquierdo magenta es la marca de procedencia, y por eso lo llevan
   los tres estados: el degradado también es del foco. */
.fc {
  display: flex;
  min-width: 0;
  border-left: 2px solid var(--ai);
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  text-align: left;
}
.fc--thin {
  align-items: center;
  gap: 0.5rem;
  min-height: var(--tap-h);
  padding: 0 0.7rem;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}
.fc__thin-text { min-width: 0; overflow-wrap: anywhere; }

.fc--card { flex-direction: column; }

.fc__glyph { flex: 0 0 auto; color: var(--ai); }

/* El encabezado es el blanco táctil del colapso: la fila entera, no el ⌄. */
.fc__head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-height: var(--tap-h);
  min-width: 0;
  padding: 0.35rem 0 0.35rem 0.7rem;
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
}
.fc__head:hover { background: var(--panel-hi); }
.fc__head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
.fc__kicker {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--ai);
}
.fc__age { color: var(--fg-dimmer); letter-spacing: 0; text-transform: none; }
.fc__headline {
  min-width: 0;
  font-size: var(--fs-body-sm);
  line-height: 1.45;
  color: var(--fg-mute);
  overflow-wrap: anywhere;
}
/* Colapsada, el headline es una línea y nada más. */
.fc__headline.is-clamped {
  display: -webkit-box;
  -webkit-line-clamp: 1;
  line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: normal;
}
.fc__chev {
  flex: 0 0 var(--tap-h);
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}

/* Un pick: un solo blanco táctil que lleva a la fila. Dos líneas en el
   teléfono; sobre 768px entra en una. */
.fc__pick {
  display: grid;
  grid-template-columns: 1rem minmax(0, 1fr);
  gap: 0.5rem;
  align-items: start;
  min-height: var(--tap-h);
  min-width: 0;
  padding: 0.45rem 0.7rem;
  border: none;
  border-top: 1px solid var(--border-mute);
  background: none;
  text-align: left;
  cursor: pointer;
}
.fc__pick:hover { background: var(--panel-hi); }
.fc__pick-body { min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
.fc__pick-top {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
}
.fc__pick-title {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  color: var(--fg);
  overflow-wrap: anywhere;
}
.fc__effort {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}
.fc__why {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: 1.4;
  color: var(--fg-mute);
  overflow-wrap: anywhere;
}

/* Un cluster NO es presionable, así que se queda en la grilla de lectura
   (`--row-h`) y no toma blanco táctil (R11). */
.fc__cluster {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  min-height: var(--row-h);
  min-width: 0;
  padding: 0.35rem 0.7rem;
  border-top: 1px solid var(--border-mute);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.fc__cluster-label { flex: 1; min-width: 0; color: var(--fg); overflow-wrap: anywhere; }
.fc__cluster-count { flex: 0 0 auto; color: var(--fg-dim); }

.fc--failed {
  align-items: center;
  gap: 0.5rem;
  min-height: var(--tap-h);
  min-width: 0;
  padding: 0.4rem 0.7rem;
  border-top: none;
  cursor: pointer;
}
.fc--failed:hover { background: var(--panel-hi); }
.fc__failed-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.fc__failed-what { color: var(--fg); overflow-wrap: anywhere; }
.fc__failed-still { color: var(--fg-dim); overflow-wrap: anywhere; }
.fc__retry {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--info);
}

/* Sobre 768px el pick entra en una línea: el `why` deja de ser un segundo
   renglón y el alto no es el recurso escaso. */
@media (min-width: 768px) {
  .fc__pick-body { flex-direction: row; align-items: baseline; gap: 0.7rem; }
  .fc__pick-top { flex: 0 1 auto; max-width: 28ch; }
  .fc__why { flex: 1; }
}
</style>
