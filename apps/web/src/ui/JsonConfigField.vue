<script setup lang="ts">
import { ref, watch } from 'vue';

/**
 * Un `Record<string, unknown>` editado como JSON crudo.
 *
 * Es el fallback de dos lugares que no se conocen entre sí: un **source** cuyo
 * kind no tiene formulario dedicado, y un **provider** registrado en el server
 * sin componente propio. Los dos existen por la misma razón —que agregar algo
 * en el server no obligue a publicar una versión de la web— y los dos tenían
 * el mismo componente escrito dos veces, con dos prefijos (`.jsf-`, `.jpf-`) y
 * la familia mono escrita a mano en vez de `--font-mono`.
 *
 * El design system la nombraba como deuda: "Textarea de JSON — tres copias".
 * Ésta es la pieza que las reemplaza.
 */
const props = withDefaults(
  defineProps<{
    modelValue: Record<string, unknown>;
    label?: string;
    /** Debajo del campo. Es donde va el porqué de que esto sea JSON crudo. */
    hint?: string;
    rows?: number;
  }>(),
  { label: 'Config (JSON)', rows: 6 },
);

const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>();

const raw = ref(JSON.stringify(props.modelValue ?? {}, null, 2));
const error = ref<string | null>(null);

/**
 * Re-serializar sólo cuando el valor de afuera dice algo distinto.
 *
 * Sin la comparación, cada tecla vuelve por el `v-model` y el `watch` pisa el
 * texto con su versión formateada: el cursor salta al final y no se puede
 * escribir. Y el texto NO se normaliza mientras se escribe — un JSON a medio
 * escribir es inválido por definición, y reformatearlo sería pelear con quien
 * lo está tipeando.
 */
watch(
  () => props.modelValue,
  (v) => {
    const next = JSON.stringify(v ?? {}, null, 2);
    if (next !== raw.value) raw.value = next;
  },
);

function onInput(e: Event) {
  const text = (e.target as HTMLTextAreaElement).value;
  raw.value = text;
  try {
    const parsed = text.trim() ? JSON.parse(text) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      error.value = null;
      emit('update:modelValue', parsed as Record<string, unknown>);
    } else {
      // Un array parsea bien y NO sirve: el consumidor espera un objeto, y
      // emitirlo rompería más adelante, lejos de acá.
      error.value = 'El JSON debe ser un objeto.';
    }
  } catch (e) {
    // El mensaje del parser, literal: dice en qué posición falla, que es lo
    // único accionable de un JSON roto.
    error.value = `JSON inválido: ${(e as Error).message}`;
  }
}
</script>

<template>
  <label class="ff-row">
    <span class="uc-label">{{ label }}</span>
    <textarea
      class="ff-field ff-textarea ff-mono"
      :class="{ 'ff-field--error': error }"
      :value="raw"
      spellcheck="false"
      :rows="rows"
      @input="onInput"
    ></textarea>
    <span v-if="error" class="ff-error">{{ error }}</span>
    <span v-if="hint" class="ff-hint">{{ hint }}</span>
  </label>
</template>

<style scoped src="@/ui/form-fields.css"></style>
