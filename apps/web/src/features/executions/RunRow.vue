<script setup lang="ts">
import type { ExecutionLog } from '@ia-flow/shared';
import ExecutionStatusLine from '@/components/ExecutionStatusLine.vue';

/**
 * La fila de una EJECUCIÓN — frames 5b (mobile) y 5d (desktop) del handoff.
 *
 * Antes esta lista era una tabla de siete columnas de ancho fijo que en 390px
 * se resolvía con `overflow-x` y un `min-width: 37rem`: la señal exacta de que
 * faltaba la fila apilada (R2). Y no era sólo el ancho — la fila decía el
 * outcome con un badge propio (`error`, `cancelled`) mientras Tareas, Board y
 * Qué sigue lo dicen con el vocabulario de `ExecutionStatusLine` (`✕ falló ·
 * tool_failure · hace 2 h`). El mismo hecho se leía distinto según la pantalla.
 *
 * Así que acá el glifo y la razón salen de `ExecutionStatusLine`, que es la
 * pieza compartida, y lo único que esta fila agrega es lo que sólo tiene
 * sentido en una lista de runs: el número del issue, quién lo corrió, cuánto
 * duró y el verbo.
 *
 * Lo que varía con el ancho es la FORMA, no el contenido:
 *
 * - Hasta 1100px: cuatro líneas —meta, título, razón, verbo— con el glifo
 *   ocupándolas todas a la izquierda.
 * - Arriba: una línea con las columnas de 5d. Las medidas las pone el padre en
 *   `--rr-cols` —una sola declaración para la fila Y su encabezado, que si se
 *   escribieran por separado dejarían de nombrar la columna que tienen
 *   debajo— y acá hay un default para quien no las declare.
 *
 * El corte es 1100 y no `--bp-stack` (640) como en `DataRow`, ni 768 como en
 * `TaskRow`, y la razón es medible: entre 768 y 1100 vuelve el sidebar y la
 * lista se queda con ~470px de ancho, así que las columnas fijas (50ch de
 * agente + duración + acción) dejaban el título en 119px — doce caracteres de
 * la única columna que se lee. 5d está dibujado a 1280, que es donde esas
 * medidas entran; 1100 es el breakpoint que el design system ya tiene para
 * "acá hay ancho de sobra".
 *
 * No usa `components/DataRow.vue` por lo mismo que `TaskRow` tampoco: aquél
 * tiene tres zonas nombradas (glifo · identidad · estado) y las celdas extra se
 * auto-ubican, así que una fila de seis zonas con una línea de verbo propia se
 * apila mal. `DataRow` sigue siendo la fila de las tablas genéricas.
 */
const props = withDefaults(
  defineProps<{
    /** El run: de acá salen el glifo y la razón. */
    execution: ExecutionLog;
    /** Lo que va en la columna ancha. */
    title: string;
    /** El issue en el provider — el título es link cuando existe. */
    titleHref?: string | null;
    /** `#1240`. Vacío cuando el id de la tarea no es un número (un node id de
     *  Projects V2 no le dice nada a nadie: mejor la columna en blanco). */
    issueLabel?: string | null;
    /** Quién corrió: el agente, o la regla cuando la fila es un disparo. */
    agent?: string;
    /** Ya formateada por el padre, que es quien tiene el tick de `now` para
     *  que la duración de un run vivo siga corriendo. */
    duration?: string;
    /** El proyecto, sólo en la pestaña global. */
    tag?: string | null;
    /** El tag queda invisible pero PRESENTE: sacarlo correría las columnas de
     *  la fila hija respecto de las de su resumen. */
    tagGhost?: boolean;
    tagTitle?: string;
    /** `▸`/`▾` cuando la fila despliega sus hijas. */
    caret?: string | null;
    /** Lo que la fila es, cuando no es un run de agente: `3 acciones`,
     *  `script`. Va pegado al título, atenuado. */
    note?: string | null;
    /** El tooltip de la nota — la regla y su evento, en el resumen de un
     *  disparo. No puede ir en el `title` de la fila: ése es el prop del
     *  título, y el atributo del mismo nombre chocaría con él. */
    noteTitle?: string;
    /** `⚠` con su explicación: una acción anterior del disparo terminó mal
     *  aunque el resultado final sea el que muestra el glifo. */
    warn?: string | null;
    /** Un cancel pedido a un contenedor ajeno: el daemon no puede probar que el
     *  run paró, así que se dice aparte y no como outcome. */
    cancelRequested?: boolean;
    /** Hay verbo. Es un prop y no `$slots.verb` porque el padre lo pasa con un
     *  `v-if` adentro: el slot existe igual y la línea quedaría vacía pero
     *  ocupando renglón. */
    hasVerb?: boolean;
    selected?: boolean;
    clickable?: boolean;
  }>(),
  { clickable: true, selected: false, tagGhost: false, cancelRequested: false, hasVerb: false },
);

const emit = defineEmits<{ open: [] }>();

/**
 * Abrir con el teclado.
 *
 * El gate es doble —sólo si es clickable, y sólo si la tecla llegó a la fila y
 * no a un control anidado— por lo mismo que en `TaskRow`: sin el segundo, un
 * espacio sobre el link del issue o sobre el verbo abre el detalle EN VEZ de
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
    class="rr"
    :class="{ 'rr--clickable': clickable, 'is-selected': selected }"
    :role="clickable ? 'button' : undefined"
    :aria-current="selected ? 'true' : undefined"
    :tabindex="clickable ? 0 : undefined"
    data-kbd-item
    @click="clickable ? emit('open') : undefined"
    @keydown="onKeydown"
  >
    <!-- El glifo, y sólo el glifo: la razón entera va en su propia zona, y
         decirla dos veces en la misma fila es ruido. -->
    <span class="rr__anchor">
      <ExecutionStatusLine class="rr__glyph-only" :execution="execution" runs-known />
    </span>

    <span class="rr__issue">
      <span v-if="tag" class="rr__tag" :class="{ 'is-ghost': tagGhost }" :title="tagTitle">{{ tag }}</span>
      <a
        v-if="issueLabel && titleHref"
        :href="titleHref"
        target="_blank"
        rel="noopener noreferrer"
        :title="`Abrir ${issueLabel} en el provider`"
        @click.stop
      >{{ issueLabel }}</a>
      <template v-else-if="issueLabel">{{ issueLabel }}</template>
    </span>

    <!-- Título y razón comparten la columna ancha en una línea (5d) y son dos
         líneas apiladas en 390px (5b). `display: contents` bajo el breakpoint
         es lo que deja que cada uno tome su propia área sin una caja de más. -->
    <span class="rr__main">
      <span class="rr__title">
        <!-- Lo que trunca es el TEXTO del título, no la celda: la nota (`2
             acciones`) y el ⚠ dicen qué ES la fila, y perderlos en el elipsis
             deja un caret que no explica qué despliega. -->
        <span class="rr__title-text" :title="title">
          <span v-if="caret" class="rr__caret" aria-hidden="true">{{ caret }}</span>
          <a
            v-if="titleHref && !issueLabel"
            :href="titleHref"
            target="_blank"
            rel="noopener noreferrer"
            @click.stop
          >{{ title }}</a>
          <template v-else>{{ title }}</template>
        </span>
        <span v-if="note" class="rr__note" :title="noteTitle">{{ note }}</span>
        <span v-if="warn" class="rr__warn" :title="warn">⚠</span>
      </span>
      <ExecutionStatusLine class="rr__state" :execution="execution" runs-known />
      <span v-if="cancelRequested" class="rr__cancel-requested">cancelación solicitada</span>
    </span>

    <span class="rr__agent" :title="agent || undefined">{{ agent || '—' }}</span>
    <span class="rr__dur">{{ duration || '—' }}</span>

    <!-- El verbo cierra la fila (O2): sólo donde hay algo que hacer, y siempre
         hacia donde eso se ejecuta hoy. Lo pone el padre, que es quien sabe si
         la acción es un endpoint o una pantalla. -->
    <span v-if="hasVerb" class="rr__verb"><slot name="verb" /></span>
  </div>
</template>

<style scoped>
/* Mobile primero (R8): cuatro líneas, con el glifo ocupándolas todas a la
   izquierda. Es la forma que SIEMPRE entra; las columnas son lo que se agrega
   cuando hay ancho. */
.rr {
  display: grid;
  grid-template-columns: 20px auto minmax(0, 1fr) auto;
  grid-template-areas:
    'anchor issue agent dur'
    'anchor title title title'
    'anchor state state cancel'
    'anchor verb  verb  verb';
  gap: 0.2rem 0.55rem;
  align-items: baseline;
  padding: 0.55rem 0.9rem;
  background: var(--panel);
  min-width: 0;
  /* La base de la fila es la mono micro — y no es cosmético: `ch` se resuelve
     contra la fuente del CONTENEDOR de la grilla, así que si acá y en el
     encabezado no fuera la misma, las mismas `--rr-cols` darían dos anchos
     distintos y las columnas dejarían de alinearse. Lo que se sale de esa base
     lo declara su celda (el título). */
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
}
.rr--clickable { cursor: pointer; }
.rr--clickable:hover { background: var(--panel-hi); }
/* La fila abierta gana la barra del acento y la superficie alta: es el ancla
   que ata la lista con el detalle, así que pisa a la zebra y al hover. */
.rr.is-selected {
  background: var(--panel-hi);
  box-shadow: inset 2px 0 0 var(--accent);
}

.rr__anchor { grid-area: anchor; display: flex; align-items: baseline; }
.rr__glyph-only :deep(.esl-text) { display: none; }

.rr__issue {
  grid-area: issue;
  display: flex;
  align-items: baseline;
  gap: 0.5ch;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dimmer);
  white-space: nowrap;
}
.rr__issue a { color: var(--fg-dimmer); text-decoration: none; }
/* Sin esto el `a:hover` global lo pinta de teal entero. */
.rr__issue a:hover { background: transparent; color: var(--info); }
.rr__tag {
  padding: 0 0.5ch;
  border: 1px solid var(--border);
  color: var(--fg-dim);
  text-overflow: ellipsis;
  overflow: hidden;
  max-width: 12ch;
}
.rr__tag.is-ghost { visibility: hidden; }

.rr__agent,
.rr__dur {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rr__agent { grid-area: agent; color: var(--info); }
.rr__dur { grid-area: dur; text-align: right; font-variant-numeric: tabular-nums; }

.rr__main { display: contents; }

.rr__title {
  grid-area: title;
  font-family: var(--font-body);
  /* Apilada, la nota fluye INLINE con el título: en flex le robaba su ancho y
     un título largo terminaba envolviendo en una columna de media pantalla. */
  min-width: 0;
  font-size: var(--fs-body);
  line-height: 1.4;
  color: var(--fg);
}
.rr__title-text {
  min-width: 0;
  /* Envuelve, NUNCA trunca en el layout apilado: el final de un título es lo
     que distingue una fila de otra. */
  text-wrap: pretty;
  overflow-wrap: anywhere;
}
.rr__title a { color: var(--fg); text-decoration: none; }
.rr__title a:hover { background: transparent; text-decoration: underline; }
.rr__caret { margin-right: 0.5ch; color: var(--fg-dimmer); }
.rr__note {
  flex: 0 0 auto;
  margin-left: 0.6ch;
  /* Se parte entera o no se parte: `400 2 / acciones` se lee como parte del
     título. */
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}

.rr__warn { flex: 0 0 auto; margin-left: 0.6ch; color: var(--warn); cursor: help; }

.rr__state { grid-area: state; min-width: 0; }
/* El glifo ya está en el ancla, a la izquierda de las cuatro líneas. */
.rr__state :deep(.esl-glyph),
.rr__state :deep(.esl-live) { display: none; }

.rr__cancel-requested {
  grid-area: cancel;
  justify-self: end;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--warn);
  white-space: nowrap;
}

/* Sin verbo NO hay renglón (el `v-if` de arriba): una fila cerrada bien no
   tiene nada que hacer, y una línea vacía la haría más alta que sus vecinas
   sin decir nada. */
.rr__verb { grid-area: verb; justify-self: start; min-width: 0; }

/* ── Una línea con columnas cuando hay ancho (5d) ─────────────────────────── */
@media (min-width: 1100px) {
  .rr {
    grid-template-columns: var(--rr-cols, 16px 8ch minmax(0, 1fr) 12ch 8ch 22ch);
    grid-template-areas: none;
    gap: 0.65rem;
    align-items: center;
    min-height: calc(var(--row-h) * 1.2);
    padding: 0 0.65rem;
  }
  /* Sin esto las celdas siguen reclamando las áreas con nombre del layout
     apilado: como acá no existen, el grid las auto-ubica y las filas se
     superponen. Con `auto`, la columna de cada una es su lugar en el DOM — que
     es el orden de 5d, y por eso el marcado está escrito en ese orden y no en
     el de la fila apilada (allá manda `grid-template-areas`, no el DOM). */
  .rr__anchor,
  .rr__issue,
  .rr__agent,
  .rr__dur,
  .rr__title,
  .rr__state,
  .rr__cancel-requested,
  .rr__verb { grid-area: auto; }
  /* `contents` deja de servir acá: título y razón comparten UNA columna, así
     que la caja que los junta tiene que existir. */
  .rr__main {
    display: flex;
    align-items: baseline;
    gap: 0.8ch;
    min-width: 0;
  }
  .rr__verb { justify-self: start; }

  .rr__title {
    flex: 0 1 auto;
    display: flex;
    align-items: baseline;
    gap: 0.6ch;
    min-width: 0;
    font-size: var(--fs-body-sm);
  }
  .rr__title-text {
    /* Acá SÍ trunca: la fila mide una línea, y la alternativa es una tabla que
       salta de alto entre filas. El título completo sigue en el `title`. */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rr__state { flex: 1 1 auto; }
  .rr__cancel-requested { flex: 0 0 auto; justify-self: auto; }
}
</style>
