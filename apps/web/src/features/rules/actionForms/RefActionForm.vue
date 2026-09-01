<script setup lang="ts">
import type { ActionFormEmits, ActionFormProps } from '@/features/rules/actionForms/types'
import ComboBox, { type ComboOption } from '@/ui/ComboBox.vue'
import HintIcon from '@/ui/HintIcon.vue'

// `ref` — correr una acción definida aparte, por id.

const props = defineProps<ActionFormProps>()
const emit = defineEmits<ActionFormEmits>()

const str = (key: string) => (typeof props.entry[key] === 'string' ? (props.entry[key] as string) : '')
const options = (): ComboOption[] => (props.actionIds ?? []).map((value) => ({ value }))
const one = (v: string | string[]) => (Array.isArray(v) ? (v[0] ?? '') : v)
</script>

<template>
  <!-- `div` y no `label`: ver el comentario en `AgentActionForm.vue`. -->
  <div class="ff-row">
    <span class="uc-label">
      Acción
      <HintIcon text="Definida aparte y compartida: editarla cambia todas las reglas que la usan." />
    </span>
    <ComboBox
      allow-custom
      class="ff-combo"
      :model-value="str('actionId')"
      :options="options()"
      placeholder="id de la acción"
      empty-text="Ninguna conocida coincide — se guarda igual"
      @update:model-value="(v) => emit('patch', { actionId: one(v) })"
    />
  </div>
</template>

<style scoped src="@/ui/form-fields.css"></style>
