<script setup lang="ts">
import { type TaskDisposition, DISPOSITION_LABELS } from '@ia-flow/shared';

/**
 * El encabezado de un bucket de disposición.
 *
 * Es lo que hace que Tareas, Qué sigue, Runs y Board se lean como **recortes
 * del mismo orden** y no como cuatro listas con cuatro criterios (O6). Por eso
 * vive en `components/` y no en una feature: si cada una lo dibujara, el orden
 * dejaría de ser uno.
 *
 * 26px y pegajoso: con veinte filas en una columna se pierde de vista en qué
 * bucket estás, y sin eso la razón de cada fila queda sin marco. Es grilla y no
 * blanco táctil salvo en `cerrado`, que sí se toca para desplegarlo.
 *
 * Tres datos y nada más: la disposición, su cuenta y —sólo en `te espera`— el
 * desempate que gobierna abajo. Ese último no es decoración: sin él, el orden
 * dentro del bucket parece arbitrario, y un orden que no se explica se
 * desconfía y se reordena a mano.
 */
const props = withDefaults(
  defineProps<{
    disposition: TaskDisposition;
    count: number;
    /** `cerrado` arranca plegado (O4): son la parte del día que NO hay que
     *  mirar, y nueve runs terminados dominando la pantalla es exactamente lo
     *  que este orden viene a arreglar. */
    collapsible?: boolean;
    open?: boolean;
    /** Se dibuja a la derecha en el bucket cerrado: `92% ok · $14.20`. */
    meta?: string;
    /**
     * Reemplaza el nombre de la disposición.
     *
     * Lo usa el board, que agrupa por STATUS y no por disposición: la pieza es
     * la misma —el encabezado pegajoso con su cuenta— pero lo que nombra es
     * otra cosa. Sin esto, el board tendría que dibujar su propio encabezado y
     * las dos vistas dejarían de verse iguales.
     */
    labelOverride?: string;
  }>(),
  { collapsible: false, open: true },
);

const emit = defineEmits<{ toggle: [] }>();

/** El desempate que gobierna el bucket. Sólo en los dos donde el orden no es
 *  el reloj obvio — decirlo en `cerrado` sería chrome. */
const RULE: Partial<Record<TaskDisposition, string>> = {
  'waiting-on-you': 'ordenado por lo que desbloquea, después por lo que lleva esperando',
  moving: 'lo que arrancó hace más, primero',
};
</script>

<template>
  <component
    :is="collapsible ? 'button' : 'div'"
    class="bh"
    :class="[labelOverride ? 'bh--neutral' : `bh--${disposition}`, { 'bh--collapsible': collapsible }]"
    :type="collapsible ? 'button' : undefined"
    :aria-expanded="collapsible ? open : undefined"
    :data-testid="`bucket-${disposition}`"
    @click="collapsible ? emit('toggle') : undefined"
  >
    <span v-if="collapsible" class="bh__caret" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
    <span class="bh__label">{{ labelOverride ?? DISPOSITION_LABELS[disposition] }}</span>
    <span class="bh__count">{{ count }}</span>
    <span v-if="!labelOverride && RULE[disposition]" class="bh__rule">{{ RULE[disposition] }}</span>
    <span v-if="meta" class="bh__meta">{{ meta }}</span>
  </component>
</template>

<style scoped>
.bh {
  display: flex;
  align-items: center;
  gap: 0.6ch;
  width: 100%;
  /* 26px: es grilla, no blanco táctil — un encabezado no se toca (salvo el
     plegable, ver abajo). */
  height: 26px;
  padding: 0 1rem;
  box-sizing: border-box;
  /* Pegajoso: con veinte filas se pierde de vista en qué bucket estás, y la
     razón de cada fila queda sin marco. `top: 0` y no `var(--tap-h)`: los
     dos consumidores (`.task-table` en TareasSection.vue, `.exec-list-
     wrapper` en ExecutionsSection.vue) son SU PROPIO contenedor de scroll —
     la barra de chrome fija vive afuera, no adentro de lo que este sticky
     recorre, así que compensarla empujaba el encabezado fuera de lugar en
     vez de pegarlo al borde de arriba. */
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--panel-hi);
  border-bottom: 1px solid var(--border);
  border-top: 1px solid var(--border);
  color: var(--fg-dim);
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  text-align: left;
}
/* El único en --danger es el único que pide algo tuyo. */
.bh--waiting-on-you { color: var(--danger); }
.bh--closed { color: var(--fg-dimmer); }
/* El board agrupa por status, no por disposición: el color de urgencia no
   aplica — un status no es más urgente que otro. */
.bh--neutral { color: var(--fg-dim); }

.bh--collapsible {
  border-width: 1px 0;
  cursor: pointer;
  /* Éste SÍ se toca: crece a --tap-h sin romper la grilla de los otros, porque
     es el último de la lista y no tiene filas debajo con las que alinearse. */
  height: var(--tap-h);
}
.bh--collapsible:hover { color: var(--fg); }

.bh__caret { flex: 0 0 auto; color: var(--fg-dimmer); }
.bh__label { flex: 0 0 auto; }
.bh__count { flex: 0 0 auto; font-weight: 700; }
/* El desempate cede primero: es lo que explica el orden, no lo que lo nombra. */
.bh__rule {
  flex: 0 1 auto;
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg-dim);
  letter-spacing: 0;
  text-transform: none;
}
.bh__meta {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--accent);
  letter-spacing: 0;
  text-transform: none;
}

/* Bajo --bp-stack no entra la frase del desempate: en 390px competía con el
   nombre del bucket y su cuenta, que son los dos datos que no pueden faltar.
   El orden sigue siendo el mismo; lo que se pierde es su explicación, y esa
   vive también en el título de la pantalla. */
@media (max-width: 640px) {
  .bh__rule { display: none; }
}
</style>
