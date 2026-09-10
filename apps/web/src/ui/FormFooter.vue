<script setup lang="ts">
/**
 * El pie de un formulario de configuración, y el único (R18, «Anatomía de un
 * formulario» en DESIGN_SYSTEM.md).
 *
 * Había **cuatro** formas de guardar en siete pantallas: `StickyActionBar`
 * (Entorno), un `.save-button` propio al final del documento (Providers, que
 * viola R3 porque la acción principal scrollea), el pie de una card (System
 * prompt) y el pie de un formulario inline (Tools, Acciones). Cuatro alturas,
 * cuatro órdenes de botones y cuatro respuestas distintas a "¿tengo algo sin
 * guardar?". Unificarlo se ve más que cualquier cambio de campo.
 *
 * **`Eliminar` va a la izquierda, separado por el ancho entero de la barra.**
 * La regla de botones del design system dice que el destructivo va último y
 * separado; "separado" es lo que manda, y en una barra de tres botones la
 * distancia máxima al primario está del otro lado. `.btn--danger` y el sufijo
 * `…`: pregunta antes de borrar, no borra.
 *
 * **El `note` no es decoración.** Un `Guardar` deshabilitado no dice por qué;
 * acá va qué falta ("falta el prompt") o qué hay pendiente ("2 cambios sin
 * guardar"). Bajo 768px es también donde aterriza el panel de checklist que en
 * escritorio vive en la tercera columna.
 *
 * **En un ámbito heredado no hay pie de guardado**: se le pasa `readonly` y
 * queda un solo `Cerrar` (ver `ScopeGroup`). Un `Guardar` apagado dice "acá se
 * podría"; lo heredado no se edita acá y punto.
 *
 * `sticky` (default) compone `StickyActionBar`: se pega bajo `--bp-shell` y se
 * suelta arriba (R3, R4, R26). Se pasa `:sticky="false"` cuando el contenedor
 * ya trae su propio pie que no scrollea — el slot `footer` de `FullScreen`.
 */
import StickyActionBar from './StickyActionBar.vue';

withDefaults(
  defineProps<{
    /** Qué falta o qué hay sin guardar. Se dibuja a la izquierda del primario. */
    note?: string;
    /** El `note` describe un problema (falta algo), no un estado (hay cambios). */
    noteIsError?: boolean;
    /** Sin cambios, o con el formulario inválido. */
    saveDisabled?: boolean;
    saveLabel?: string;
    /** Texto del destructivo. Sin esto no se dibuja (un alta no borra nada). */
    deleteLabel?: string;
    /** Ámbito heredado: sólo `Cerrar`. */
    readonly?: boolean;
    /** `false` cuando el contenedor ya aporta un pie que no scrollea. */
    sticky?: boolean;
  }>(),
  {
    note: undefined,
    noteIsError: false,
    saveDisabled: false,
    saveLabel: 'Guardar',
    deleteLabel: undefined,
    readonly: false,
    sticky: true,
  },
);

const emit = defineEmits<{ save: []; cancel: []; delete: [] }>();
</script>

<template>
  <component
    :is="sticky ? StickyActionBar : 'div'"
    :class="sticky ? undefined : 'ffoot'"
    :note="sticky ? note : undefined"
    :note-is-error="sticky ? noteIsError : undefined"
  >
    <template v-if="sticky" #lead>
      <button
        v-if="deleteLabel && !readonly"
        type="button"
        class="btn btn--danger"
        @click="emit('delete')"
      >{{ deleteLabel }}</button>
    </template>

    <!-- Sin `sticky` el contenedor no dibuja ni `lead` ni `note`: van acá, en
         el mismo orden, para que el pie se lea igual en los dos modos. -->
    <template v-if="!sticky">
      <button
        v-if="deleteLabel && !readonly"
        type="button"
        class="btn btn--danger"
        @click="emit('delete')"
      >{{ deleteLabel }}</button>
      <p
        v-if="note"
        class="ffoot__note"
        :class="{ 'ffoot__note--error': noteIsError }"
      >{{ note }}</p>
      <span v-else class="ffoot__spacer" />
    </template>

    <button type="button" class="btn" @click="emit('cancel')">
      {{ readonly ? 'Cerrar' : 'Cancelar' }}
    </button>
    <button
      v-if="!readonly"
      type="button"
      class="btn btn--primary"
      :disabled="saveDisabled"
      @click="emit('save')"
    >{{ saveLabel }}</button>
  </component>
</template>

<style scoped>
/* Sólo el modo NO sticky trae caja propia: el sticky la hereda entera de
   `StickyActionBar`, que es la primitiva y no se reimplementa acá. */
.ffoot {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
}
.ffoot__note {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--fg-dim);
}
.ffoot__note--error { color: var(--danger); }
.ffoot__spacer { flex: 1 1 auto; }
</style>
