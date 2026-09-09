<script setup lang="ts">
import type { ExecutionLog, TaskDisposition, TaskVerb } from '@ia-flow/shared';
import { computed } from 'vue';
import ExecutionStatusLine from '@/components/ExecutionStatusLine.vue';

/**
 * La fila de una tarea — **una sola**, para las tres pantallas que la muestran.
 *
 * Tareas, Board y Qué sigue dibujaban la misma fila con tres marcados distintos
 * (`.task-row`, `.bd-row`, `.nu-row`), y la consecuencia no era estética: las
 * tres decían lo mismo de formas parecidas pero no iguales —una mostraba la
 * razón, otra la línea de estado, otra las dos— así que la misma tarea se leía
 * distinto según desde dónde la miraras. Las tres son recortes del mismo orden
 * (O6); tienen que ser también la misma fila.
 *
 * Lo que varía entre pantallas es el ANCHO disponible, no el contenido:
 *
 * - `table` — Tareas, que tiene la página entera: columnas sobre `--bp-stack`.
 * - `stacked` — Board y Qué sigue, que viven en una columna angosta: siempre
 *   dos líneas.
 *
 * Y dos piezas opcionales que sólo Qué sigue usa: el **puesto** en la cola
 * (§3: el bucket 1 va numerado) y el **verbo** (O2: sólo donde te toca a vos).
 */
const props = withDefaults(
  defineProps<{
    title: string;
    issueNumber?: number;
    issueUrl?: string;

    /**
     * La razón de su disposición (O1) — por qué está en su bucket.
     *
     * Cuando está, **reemplaza** a la línea de estado en vez de sumarse: la
     * razón la arma el server y ya trae lo que aquélla decía (`PR #1233 · CI ✓`)
     * más lo que no puede saber (`no hay regla de retry`). Tener las dos hacía
     * que la fila dijera `sin ejecutar` dos veces y le comía el ancho al título.
     */
    reason?: string;
    disposition?: TaskDisposition;

    /** El fallback cuando no hay disposición: decir el estado es mejor que
     *  no decir nada. */
    execution?: ExecutionLog | null;
    attempts?: number;
    blocked?: boolean;
    runsKnown?: boolean;
    pullRequestsKnown?: boolean;
    hasOpenPr?: boolean;

    /** Sólo en `table`. */
    agent?: string;
    duration?: string;

    /**
     * La tarea ya está en la última columna del pipeline de la fuente (p. ej.
     * `Done` en el board), aunque ningún agente la haya corrido nunca —
     * alguien la resolvió por fuera de ia-flow. Sin esto se lee exactamente
     * igual que una tarea que nadie tocó, y no es lo mismo: una no tiene
     * trabajo pendiente, la otra sí.
     */
    doneInSource?: boolean;

    /** El puesto en la cola. Sólo el bucket `te espera` lo lleva. */
    rank?: string | null;
    /** El verbo, con su destino ya resuelto por el server. */
    verb?: TaskVerb | null;
    verbBusy?: boolean;

    layout?: 'table' | 'stacked';
    clickable?: boolean;
    /** La fila abierta en la columna de detalle. Con dos columnas a la vista,
     *  sin esto no hay forma de saber cuál de todas se está mirando. */
    selected?: boolean;
  }>(),
  { layout: 'stacked', clickable: true, verbBusy: false, selected: false },
);

const emit = defineEmits<{ open: []; verb: [] }>();

/** El bullet inicial se tiñe distinto sólo cuando `doneInSource` es la razón
 *  real de que no haya ejecución — un run vivo, fallido o bloqueado ya tiene
 *  su propio color y ese es el que manda. */
const glyphDoneInSource = computed(() => props.doneInSource && !props.execution);

/**
 * Abrir con el teclado.
 *
 * El gate es doble —sólo si es clickable, y sólo si la tecla llegó a la fila y
 * no a un control anidado— por lo mismo que en `EditableCard`: sin el segundo,
 * un espacio sobre el link del issue o sobre el verbo abre el detalle EN VEZ de
 * activar lo que se estaba tocando.
 */
function onKeydown(e: KeyboardEvent) {
  if (!props.clickable) return;
  if (e.target !== e.currentTarget) return;
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  emit('open');
}
</script>

<template>
  <div
    class="tr"
    :class="[`tr--${layout}`, { 'tr--clickable': clickable, 'is-selected': selected }]"
    :role="clickable ? 'button' : undefined"
    :aria-current="selected ? 'true' : undefined"
    :tabindex="clickable ? 0 : undefined"
    data-kbd-item
    @click="clickable ? emit('open') : undefined"
    @keydown="onKeydown"
  >
    <!-- El puesto va donde el glifo en las otras pantallas: es el ancla
         izquierda de la fila, y sólo una de las dos existe a la vez. -->
    <span v-if="rank" class="tr__rank" aria-hidden="true">{{ rank }}</span>
    <span v-else class="tr__glyph" :class="{ 'tr__glyph--done-in-source': glyphDoneInSource }">
      <ExecutionStatusLine
        class="tr__glyph-only"
        :execution="execution ?? null"
        :attempts="attempts"
        :blocked="blocked"
        :runs-known="runsKnown"
        :pull-requests-known="pullRequestsKnown"
        :has-open-pr="hasOpenPr"
      />
    </span>

    <span class="tr__title" :title="title">{{ title }}</span>

    <a
      v-if="issueNumber && issueUrl"
      class="tr__issue"
      :href="issueUrl"
      target="_blank"
      rel="noopener"
      :title="`Abrir #${issueNumber} en el provider`"
      @click.stop
    >#{{ issueNumber }}</a>
    <span v-else-if="issueNumber" class="tr__issue is-plain">#{{ issueNumber }}</span>
    <span v-else class="tr__issue is-plain"></span>

    <!-- La razón ocupa el lugar de la línea de estado, no se suma a ella. -->
    <span
      v-if="reason"
      class="tr__state tr__reason"
      :class="disposition ? `is-${disposition}` : undefined"
      :title="reason"
    >{{ reason }}</span>
    <ExecutionStatusLine
      v-else
      class="tr__state"
      :execution="execution ?? null"
      :attempts="attempts"
      :blocked="blocked"
      :runs-known="runsKnown"
      :pull-requests-known="pullRequestsKnown"
      :has-open-pr="hasOpenPr"
    />

    <span v-if="layout === 'table'" class="tr__agent">{{ agent ?? '—' }}</span>
    <span v-if="layout === 'table'" class="tr__dur">{{ duration ?? '—' }}</span>

    <!-- El verbo cierra la fila (O2). El destino lo decidió el server. -->
    <button
      v-if="verb"
      type="button"
      class="tr__verb"
      :disabled="verbBusy"
      data-testid="task-row-verb"
      @click.stop="emit('verb')"
    >
      → {{ verbBusy ? 'Despachando…' : verb.label }}
      <span v-if="verb.hint" class="tr__verb-hint">{{ verb.hint }}</span>
    </button>
  </div>
</template>

<style scoped>
/* Mobile primero (R8): dos líneas, con el ancla ocupando las dos a la
   izquierda. Es la forma que SIEMPRE entra; las columnas son lo que se agrega
   cuando hay ancho. */
.tr {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  grid-template-areas:
    'anchor title issue'
    'anchor state state'
    'anchor verb  verb';
  gap: 0.2rem 0.55rem;
  align-items: baseline;
  padding: 0.55rem 0.9rem;
  background: var(--panel);
  min-width: 0;
}
/* Zebra: la separación entre filas densas la da la superficie, no un borde más
   — con hairline Y zebra la lista se lee como una grilla de Excel. */
.tr:nth-child(even) { background: var(--panel-alt); }
.tr + .tr { border-top: 1px solid var(--border-mute); }
.tr--clickable { cursor: pointer; }
.tr--clickable:hover { background: var(--panel-hi); }

/* La fila abierta gana la barra del acento y la superficie alta: es el ancla
   que ata la lista con la columna de detalle, así que pisa a la zebra y al
   hover (de ahí que vaya después de los dos). */
.tr.is-selected {
  background: var(--panel-hi);
  box-shadow: inset 2px 0 0 var(--accent);
}

.tr__glyph,
.tr__rank { grid-area: anchor; display: flex; align-items: baseline; overflow: hidden; }
/* La fuente ya la dio por terminada aunque ningún agente la haya corrido: un
   `○` gris se lee igual que "nadie la tocó", que es exactamente lo que NO es
   este caso. */
.tr__glyph--done-in-source :deep(.esl-glyph) { color: var(--accent); }
/* `ExecutionStatusLine` siempre trae su texto (`esl-text`) pegado al glifo —
   acá sólo hay lugar para el glifo (el texto completo vive en `.tr__state` /
   la fila de abajo). Sin ocultarlo, ese texto se desbordaba de la columna de
   16-20px y quedaba una esquirla asomando debajo del título. */
.tr__glyph-only :deep(.esl-text) { display: none; }
.tr__rank {
  font-family: var(--font-mono);
  font-size: var(--fs-chrome);
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

.tr__title {
  grid-area: title;
  min-width: 0;
  font-size: var(--fs-body);
  line-height: 1.4;
  color: var(--fg);
  /* Envuelve, NUNCA trunca en el layout apilado: el final de un título es lo
     que distingue una fila de otra. */
  text-wrap: pretty;
  overflow-wrap: anywhere;
}
.tr__issue {
  grid-area: issue;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dimmer);
  text-decoration: none;
  white-space: nowrap;
}
/* Sin esto el `a:hover` global lo pinta de teal entero. */
.tr__issue:hover:not(.is-plain) { background: transparent; color: var(--info); }

.tr__state {
  grid-area: state;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* El color de la razón sale de su disposición: el único en --danger es el que
   pide algo tuyo. */
.tr__reason.is-waiting-on-you { color: var(--danger); }
.tr__reason.is-blocked { color: var(--warn); }
.tr__reason.is-moving { color: var(--accent); }
.tr__reason.is-closed { color: var(--fg-dimmer); }

.tr__verb {
  grid-area: verb;
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  /* Se toca: --tap-h de área (R1). */
  min-height: var(--tap-h);
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  cursor: pointer;
}
.tr__verb:hover:not(:disabled) { text-decoration: underline; }
.tr__verb:disabled { color: var(--fg-dim); cursor: progress; }
.tr__verb-hint { color: var(--fg-dimmer); font-size: var(--fs-micro); }

.tr__agent,
.tr__dur { display: none; }

/* ── `table`: columnas cuando hay ancho ───────────────────────────────────── */
@media (min-width: 768px) {
  .tr--table {
    /* El padre (`.task-table` en TareasSection.vue) puede pisar `--tr-cols`
     * con los anchos que el operador arrastró — mismo patrón que `--rr-cols`
     * en RunRow/ExecutionsSection, para que el encabezado de columnas y cada
     * fila midan siempre lo mismo sin declararlo dos veces. */
    grid-template-columns: var(--tr-cols, 16px 40ch minmax(60px, 1fr) 13ch 11ch 7ch);
    grid-template-areas: none;
    gap: 0.65rem;
    align-items: center;
    height: calc(var(--row-h) * 1.2);
    padding: 0 0.65rem;
  }
  /* Sin esto las celdas siguen reclamando las áreas con nombre del layout
     apilado: como acá no existen, el grid las auto-ubica y las filas se
     superponen. En una línea el orden de columnas ES el del template. */
  .tr--table .tr__glyph,
  .tr--table .tr__rank,
  .tr--table .tr__title,
  .tr--table .tr__issue,
  .tr--table .tr__state,
  .tr--table .tr__verb { grid-area: auto; }

  .tr--table .tr__title {
    font-size: var(--fs-body-sm);
    /* Acá SÍ trunca: la fila mide una línea, y la alternativa es una tabla que
       salta de alto entre filas. El título completo sigue en el `title`. */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tr--table .tr__agent,
  .tr--table .tr__dur {
    display: block;
    font-family: var(--font-mono);
    font-size: var(--fs-micro);
    color: var(--fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tr--table .tr__dur { text-align: right; }
  /* En una línea el glifo de la línea de estado sobra: la columna de estado ya
     lo lleva, y decirlo dos veces en la misma fila es ruido. */
  .tr--table .tr__state :deep(.esl-glyph) { display: none; }
}
</style>
