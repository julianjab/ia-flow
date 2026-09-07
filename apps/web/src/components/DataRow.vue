<script setup lang="ts">
/**
 * Una fila de datos: columnas en desktop, dos líneas apiladas en mobile (T6).
 *
 * La regla del arquetipo A4: **una tabla con `grid-template-columns` en `ch`
 * nunca cabe en 390px**. Las opciones son scroll horizontal (R2, prohibido
 * salvo comparación explícita) o comprimir hasta que las columnas no digan
 * nada. La tercera es ésta: bajo `--bp-stack` la fila se parte en dos líneas
 * —identidad arriba, estado abajo— con el glifo fijo a la izquierda.
 *
 * Existe porque cada tabla de la app la resolvía por su cuenta: tareas, board,
 * salud por agente, providers, catálogo MCP. Cinco implementaciones del mismo
 * problema, y cada una eligió otro ancho de glifo y otro punto de quiebre.
 *
 * Lo que NO hace: decidir el contenido. Las columnas llegan por slots
 * nombrados, así que una tabla puede tener las suyas sin que este componente
 * sepa de qué dominio es — por eso puede vivir en `components/`.
 */
withDefaults(
  defineProps<{
    /**
     * El `grid-template-columns` de la línea, en desktop. En `ch` para que las
     * columnas se alineen entre filas sin medir nada.
     */
    columns: string;
    /** La fila abre un detalle. Sin esto no es presionable y no toma --tap-h. */
    clickable?: boolean;
    /** Se atenúa: cerrada, heredada, deshabilitada. */
    muted?: boolean;
    active?: boolean;
  }>(),
  { clickable: false, muted: false, active: false },
);

const emit = defineEmits<{ open: [] }>();

/**
 * Abrir con el teclado.
 *
 * El gate es doble —sólo si la fila es clickable, y sólo si la tecla llegó a la
 * fila y no a un control anidado— por lo mismo que en `EditableCard`: sin el
 * segundo, un espacio sobre un botón de adentro abre el detalle EN VEZ de
 * activar el botón.
 */
function onKeydown(e: KeyboardEvent, clickable: boolean) {
  if (!clickable) return;
  if (e.target !== e.currentTarget) return;
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  emit('open');
}
</script>

<template>
  <div
    class="dr"
    :class="{ 'dr--clickable': clickable, 'dr--muted': muted, 'dr--active': active }"
    :style="{ '--dr-columns': columns }"
    :role="clickable ? 'button' : undefined"
    :tabindex="clickable ? 0 : undefined"
    data-kbd-item
    @click="clickable ? emit('open') : undefined"
    @keydown="onKeydown($event, clickable)"
  >
    <span class="dr__glyph"><slot name="glyph" /></span>
    <span class="dr__identity"><slot name="identity" /></span>
    <span class="dr__state"><slot name="state" /></span>
    <slot />
  </div>
</template>

<style scoped>
/* Mobile primero (R8): dos líneas, con el glifo ocupando las dos a la
   izquierda. Es la forma que SIEMPRE entra; las columnas son lo que se agrega
   cuando hay ancho. */
.dr {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  grid-template-areas:
    'glyph identity'
    'glyph state';
  gap: 0.2rem 0.55rem;
  align-items: baseline;
  padding: 0.55rem 0.9rem;
  background: var(--panel);
  min-width: 0;
}
.dr__glyph { grid-area: glyph; display: flex; align-items: baseline; }
.dr__identity { grid-area: identity; min-width: 0; }
.dr__state { grid-area: state; min-width: 0; }

/* Zebra: la separación entre filas densas la da la superficie, no un borde más
   — con hairline Y zebra la lista se lee como una grilla de Excel. */
.dr:nth-child(even) { background: var(--panel-alt); }
.dr + .dr { border-top: 1px solid var(--border-mute); }

.dr--muted { opacity: 0.7; }
.dr--muted:hover { opacity: 1; }
.dr--active { background: var(--panel-hi); }
.dr--clickable { cursor: pointer; }
.dr--clickable:hover { background: var(--panel-hi); }

/* Sobre --bp-stack hay ancho para las columnas. El alto pasa a ser fijo de una
   línea: una tabla que salta de alto entre filas no se puede barrer con la
   vista, que es para lo que existe. */
@media (min-width: 640px) {
  .dr {
    grid-template-columns: var(--dr-columns);
    grid-template-areas: none;
    gap: 0.65rem;
    align-items: center;
    height: calc(var(--row-h) * 1.2);
    padding: 0 0.65rem;
  }
  /* Sin esto las celdas siguen reclamando las áreas con nombre del layout
     apilado: como acá no existen, el grid las auto-ubica y las filas se
     superponen. En una línea el orden de columnas ES el del template. */
  .dr__glyph,
  .dr__identity,
  .dr__state {
    grid-area: auto;
  }
  /* En una línea todo trunca: la alternativa es que la fila crezca y la tabla
     deje de tener ritmo. El texto completo vive en el `title` y en el detalle. */
  .dr__identity,
  .dr__state {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

/* La fila es presionable: --tap-h, no --row-h (R1). Sólo cuando abre algo — una
   fila de sólo lectura es grilla y se queda en su alto denso. */
.dr--clickable { min-height: var(--tap-h); }
@media (min-width: 640px) {
  .dr--clickable { height: auto; min-height: calc(var(--row-h) * 1.2); }
}
</style>
