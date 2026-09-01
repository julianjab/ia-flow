<script setup lang="ts">
import type { ActionFormEmits, ActionFormProps } from '@/features/rules/actionForms/types'
import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue'

// `agent` — correr un agente cuando la regla matchea.

const props = defineProps<ActionFormProps>()
const emit = defineEmits<ActionFormEmits>()

const str = (key: string) => (typeof props.entry[key] === 'string' ? (props.entry[key] as string) : '')

// Las llaves dobles del ejemplo se arman acá y no en el template: escritas
// literalmente, el parser de Vue las lee como una interpolación suya.
const VAR_TYPE = '{{event.type}}'
const VAR_PR = '{{event.payload.pr.number}}'
const BRIEF_PLACEHOLDER = `Llegó feedback nuevo sobre el PR #${VAR_PR} — atendé ese pedido, no re-implementes.`

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
  <div class="ff-row">
    <span class="uc-label">Agente</span>
    <ComboBox
      allow-custom
      class="ff-combo"
      :model-value="str('agentId')"
      :options="options()"
      placeholder="id del agente"
      empty-text="Ninguno conocido coincide — se guarda igual"
      @update:model-value="(v) => emit('patch', { agentId: one(v) })"
    />
  </div>

  <label class="ff-row">
    <span class="uc-label">Por qué corre</span>
    <textarea
      class="ff-field ff-textarea"
      rows="3"
      :value="str('brief')"
      :placeholder="BRIEF_PLACEHOLDER"
      @input="emit('patch', { brief: ($event.target as HTMLTextAreaElement).value || undefined })"
    ></textarea>
    <span class="ff-hint">
      Se antepone al prompt del agente. Es lo único que la regla sabe y el agente no:
      qué lo despertó. Admite <code>{{ VAR_TYPE }}</code> y cualquier camino del
      payload (<code>{{ VAR_PR }}</code>).
    </span>
  </label>

  <label class="ff-check">
    <input
      type="checkbox"
      :checked="entry.emitOn === 'exit'"
      @change="toggleEmit(($event.target as HTMLInputElement).checked)"
    />
    <span>Publicar el resultado del run como evento</span>
  </label>

  <label v-if="entry.emitOn === 'exit'" class="ff-row">
    <span class="uc-label">Tipo del evento</span>
    <input
      class="ff-field ff-mono"
      :value="str('emitType')"
      placeholder="run.finished"
      @input="emit('patch', { emitType: ($event.target as HTMLInputElement).value || undefined })"
    />
    <span class="ff-hint">
      Vacío ⇒ <code>run.finished</code>. Es lo que convierte a un agente en normalizador:
      su salida entra al bus como un evento que otras reglas pueden ver.
    </span>
  </label>
</template>

<style scoped src="@/ui/form-fields.css"></style>
