<script setup lang="ts">
import type { WhenCondition } from '@ia-flow/shared'
import { ref, watch } from 'vue'
import ConditionRowsEditor from '@/ui/ConditionRowsEditor.vue'
import type { ConditionRow } from '@/ui/condition-rows'
import { rowsToWhen, whenToRows } from '@/features/rules/when-serialization'

// v-model sobre `RuleActionEntry.when` — condiciona ESTA acción del `do[]`,
// no la regla entera. Mismo DSL/UI que el `when` de "Sobre qué"
// (`RuleScopeEditor.vue`), pero evaluado también contra `steps.*`: el campo
// típico acá es `steps.<paso>.output.<campo>`, no uno del evento.
//
// Estado local + `lastEmitted`: mismo motivo que
// `features/agents/WhenConditionsEditor.vue` — sin buffer, una fila a medio
// escribir (`field: ''`) se filtra en `rowsToWhen`, el padre devuelve el
// array sin ella, y el watcher del prop la borra antes de que el operador
// llegue a escribir el campo.

const props = defineProps<{
  modelValue: WhenCondition[] | undefined
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: WhenCondition[] | undefined): void
}>()

const OPS = [
  { value: '=', label: '= igual' },
  { value: '!=', label: '!= distinto' },
  { value: '$contains', label: 'contiene' },
  { value: '$matches', label: 'matchea regex' },
  { value: '>', label: '> mayor' },
  { value: '>=', label: '>= mayor o igual' },
  { value: '<', label: '< menor' },
  { value: '<=', label: '<= menor o igual' },
  { value: '$null', label: 'es nulo' },
  { value: '$not_null', label: 'no es nulo' },
]

const rows = ref<ConditionRow[]>(whenToRows(props.modelValue))
let lastEmitted: string | null = null

watch(
  () => props.modelValue,
  (next) => {
    if (JSON.stringify(next ?? []) === lastEmitted) return
    rows.value = whenToRows(next)
  },
)

function onRows(next: ConditionRow[]) {
  rows.value = next
  const when = rowsToWhen(next)
  lastEmitted = JSON.stringify(when ?? [])
  emit('update:modelValue', when)
}
</script>

<template>
  <ConditionRowsEditor
    :model-value="rows"
    logic
    :ops="OPS"
    field-placeholder="p. ej. steps.triage.output.actionable"
    value-placeholder="valor"
    :op-takes-value="(op: string) => op !== '$null' && op !== '$not_null'"
    @update:model-value="onRows"
  />
</template>
