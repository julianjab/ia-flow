<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { WhenCondition } from '@ia-flow/shared'
import ConditionRowsEditor from '@/ui/ConditionRowsEditor.vue'
import type { ConditionRow } from '@/ui/condition-rows'
import {
  type AgentCondition,
  type ConditionOp,
  entryToWhen,
  opTakesValue,
  type ProjectField,
  whenToConditions,
} from '@/features/agents/outcomes-serialization'

// v-model over WhenCondition[] — condiciones contra los campos del issue que
// el engine evalúa para decidir si este agente es candidato (ver
// AgentActivationSchema.when en packages/shared/src/schemas.ts).
//
// La fila y su lenguaje visual son `ui/ConditionRowsEditor`, compartidos con
// las reglas y con la admisión de un agent-host. Lo que queda acá es lo que sí
// es del dominio del agente: la serialización del DSL (incluido el formato
// Record legacy) y el catálogo de campos y valores del proyecto.

const props = defineProps<{
  modelValue: WhenCondition[]
  projectFields?: ProjectField[]
  statusOptions?: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: WhenCondition[]): void
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

// Editable form state — kept local so partial edits (e.g. a field typed but
// no value yet) don't force an invalid WhenCondition upstream on every
// keystroke. Re-synced from the prop whenever it changes shape from outside
// (e.g. hydrating a different agent).
const conditions = ref<AgentCondition[]>(whenToConditions(props.modelValue))

// Serialización de lo último que emitimos. Sin esto, agregar una condición es
// imposible: la fila nueva nace con `field: ''`, `entryToWhen` la filtra, el
// padre nos devuelve el array sin ella y el watcher la borra de la lista local
// antes de que el usuario llegue a escribir el campo. Comparando contra lo
// último emitido, el eco del padre se ignora y sólo resincronizamos cuando el
// cambio viene de afuera de verdad (hidratar otro agente).
let lastEmitted: string | null = null

watch(
  () => props.modelValue,
  (next) => {
    if (JSON.stringify(next ?? []) === lastEmitted) return
    conditions.value = whenToConditions(next)
  },
)

function onRows(rows: ConditionRow[]) {
  conditions.value = rows.map((r) => ({
    field: r.field,
    op: r.op as ConditionOp,
    value: r.value,
    logic: r.logic ?? 'and',
  }))
  const when = entryToWhen(conditions.value)
  lastEmitted = JSON.stringify(when)
  emit('update:modelValue', when)
}

const fieldNames = computed(() => (props.projectFields ?? []).map((f) => f.name))

function optionsFor(fieldName: string): string[] {
  if (fieldName.toLowerCase() === 'status') return props.statusOptions ?? []
  return (
    (props.projectFields ?? []).find((f) => f.name.toLowerCase() === fieldName.toLowerCase())
      ?.options ?? []
  )
}

// El catálogo de valores del campo (labels, opciones de un select del board)
// sólo tiene sentido para igualdad. Un número, una regex o un substring no son
// valores del catálogo, así que esos ops siempre editan a mano.
function valueOptions(row: ConditionRow): string[] {
  if (row.op !== '=' && row.op !== '!=') return []
  return optionsFor(row.field)
}

function placeholderFor(op: string): string {
  if (op === '$matches') return 'p. ej. ^feat/'
  if (op === '$contains') return 'p. ej. login'
  if (op === '>' || op === '>=' || op === '<' || op === '<=') return 'p. ej. 500'
  return 'p. ej. agent:refine'
}
</script>

<template>
  <ConditionRowsEditor
    logic
    :model-value="conditions"
    :fields="fieldNames"
    :ops="OPS"
    :value-options="valueOptions"
    :op-takes-value="(op: string) => opTakesValue(op as ConditionOp)"
    field-placeholder="p. ej. status"
    :value-placeholder="placeholderFor"
    :empty-row="() => ({ field: '', op: '=', value: '', logic: 'and' })"
    @update:model-value="onRows"
  />
</template>
