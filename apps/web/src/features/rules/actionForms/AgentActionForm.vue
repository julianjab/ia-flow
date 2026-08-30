<script setup lang="ts">
import type { ActionFormEmits, ActionFormProps } from '@/features/rules/actionForms/types'
import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue'

// `agent` — correr un agente cuando la regla matchea.

const props = defineProps<ActionFormProps>()
const emit = defineEmits<ActionFormEmits>()

const str = (key: string) => (typeof props.entry[key] === 'string' ? (props.entry[key] as string) : '')

const options = (): ComboOption[] => (props.agentIds ?? []).map((value) => ({ value }))
const one = (v: string | string[]) => (Array.isArray(v) ? (v[0] ?? '') : v)

/** `emitOn` es un enum de un solo valor (`'exit'`), así que se edita como un
 *  check: un desplegable con una opción es una decisión disfrazada de menú. */
function toggleEmit(on: boolean) {
  emit('patch', on ? { emitOn: 'exit' } : { emitOn: undefined, emitType: undefined })
}
</script>

<template>
  <!-- `div` y no `label`: un `<label>` reenvía el click de cualquier
       descendiente a su PRIMER control, y en un ComboBox con chips ése es la
       ✕ del primer chip. Ver el comentario en `ui/ComboBox.vue`. -->
  <div class="af-row">
    <span class="af-lbl">Agente</span>
    <ComboBox
      allow-custom
      class="af-combo"
      :model-value="str('agentId')"
      :options="options()"
      placeholder="id del agente"
      empty-text="Ninguno conocido coincide — se guarda igual"
      @update:model-value="(v) => emit('patch', { agentId: one(v) })"
    />
  </div>

  <label class="af-check">
    <input
      type="checkbox"
      :checked="entry.emitOn === 'exit'"
      @change="toggleEmit(($event.target as HTMLInputElement).checked)"
    />
    <span>Publicar el resultado del run como evento</span>
  </label>

  <label v-if="entry.emitOn === 'exit'" class="af-row">
    <span class="af-lbl">Tipo del evento</span>
    <input
      class="af-field af-mono"
      :value="str('emitType')"
      placeholder="run.finished"
      @input="emit('patch', { emitType: ($event.target as HTMLInputElement).value || undefined })"
    />
    <span class="af-hint">
      Vacío ⇒ <code>run.finished</code>. Es lo que convierte a un agente en normalizador:
      su salida entra al bus como un evento que otras reglas pueden ver.
    </span>
  </label>
</template>

<style scoped src="./fields.css"></style>
