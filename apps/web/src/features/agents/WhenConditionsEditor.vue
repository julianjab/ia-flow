<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { WhenCondition } from '@ia-flow/shared'
import {
  type AgentCondition,
  type ConditionOp,
  entryToWhen,
  type ProjectField,
  whenToConditions,
} from '@/features/agents/outcomes-serialization'

// v-model over WhenCondition[] — condiciones contra los campos del issue que
// el engine evalúa para decidir si este agente es candidato (ver
// AgentActivationSchema.when en packages/shared/src/schemas.ts).

const props = defineProps<{
  modelValue: WhenCondition[]
  projectFields?: ProjectField[]
  statusOptions?: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: WhenCondition[]): void
}>()

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

function emitConditions(next: AgentCondition[]) {
  conditions.value = next
  const when = entryToWhen(next)
  lastEmitted = JSON.stringify(when)
  emit('update:modelValue', when)
}

function fieldNames(): string[] {
  return (props.projectFields ?? []).map((f) => f.name)
}

function optionsFor(fieldName: string): string[] {
  if (fieldName.toLowerCase() === 'status') return props.statusOptions ?? []
  return (
    (props.projectFields ?? []).find((f) => f.name.toLowerCase() === fieldName.toLowerCase())
      ?.options ?? []
  )
}

function addCondition() {
  emitConditions([...conditions.value, { field: '', op: '=', value: '', logic: 'and' }])
}

function removeCondition(i: number) {
  emitConditions(conditions.value.filter((_, idx) => idx !== i))
}

function updateCondition(i: number, patch: Partial<AgentCondition>) {
  emitConditions(conditions.value.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
}

function toggleConditionLogic(i: number) {
  const current = conditions.value[i]?.logic ?? 'and'
  updateCondition(i, { logic: current === 'and' ? 'or' : 'and' })
}

const hasFieldOptions = computed(() => fieldNames().length > 0)
</script>

<template>
  <div class="wce">
    <template v-for="(c, ci) in conditions" :key="ci">
      <div v-if="ci > 0" class="wce-logic-row">
        <button
          type="button"
          class="wce-logic-badge"
          :class="c.logic ?? 'and'"
          :title="`Conector: ${(c.logic ?? 'and').toUpperCase()} — clic para cambiar`"
          @click="toggleConditionLogic(ci)"
        >{{ (c.logic ?? 'and').toUpperCase() }}</button>
      </div>
      <div class="wce-row">
        <div class="wce-cell wce-cell-field">
          <span class="wce-lbl">Campo</span>
          <select
            v-if="hasFieldOptions"
            :value="c.field"
            class="wce-field"
            @change="updateCondition(ci, { field: ($event.target as HTMLSelectElement).value })"
          >
            <option value="" disabled>— Campo —</option>
            <option v-for="fn in fieldNames()" :key="fn" :value="fn">{{ fn }}</option>
          </select>
          <input
            v-else
            :value="c.field"
            class="wce-field"
            placeholder="p. ej. status"
            @input="updateCondition(ci, { field: ($event.target as HTMLInputElement).value })"
          />
        </div>

        <div class="wce-cell wce-cell-op">
          <span class="wce-lbl">Operador</span>
          <select
            :value="c.op"
            class="wce-field"
            @change="updateCondition(ci, { op: ($event.target as HTMLSelectElement).value as ConditionOp, value: '' })"
          >
            <option value="=">= igual</option>
            <option value="!=">!= distinto</option>
            <option value="$null">es nulo</option>
            <option value="$not_null">no es nulo</option>
          </select>
        </div>

        <div v-if="c.op === '=' || c.op === '!='" class="wce-cell wce-cell-value">
          <span class="wce-lbl">Valor</span>
          <select
            v-if="optionsFor(c.field).length"
            :value="c.value"
            class="wce-field"
            @change="updateCondition(ci, { value: ($event.target as HTMLSelectElement).value })"
          >
            <option value="" disabled>— Valor —</option>
            <option v-for="opt in optionsFor(c.field)" :key="opt" :value="opt">{{ opt }}</option>
          </select>
          <input
            v-else
            :value="c.value"
            class="wce-field"
            placeholder="p. ej. agent:refine"
            @input="updateCondition(ci, { value: ($event.target as HTMLInputElement).value })"
          />
        </div>

        <button
          type="button"
          class="wce-remove"
          aria-label="Quitar condición"
          @click="removeCondition(ci)"
        >✕</button>
      </div>
    </template>
    <button type="button" class="wce-add" @click="addCondition">+ condición</button>
  </div>
</template>

<style scoped>
.wce {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.wce-logic-row { display: flex; align-items: center; }
.wce-logic-badge {
  font-size: var(--fs-micro);
  font-weight: 700;
  letter-spacing: var(--tracking-lbl);
  padding: 0 0.4ch;
  height: var(--row-h);
  line-height: var(--row-h);
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--panel);
  font-family: var(--font-mono);
}
.wce-logic-badge.and { color: var(--ai); border-color: var(--ai); }
.wce-logic-badge.or { color: var(--warn); border-color: var(--warn); background: var(--yellow-bg); }

.wce-row {
  display: flex;
  align-items: flex-end;
  gap: 0.4rem;
}
.wce-cell {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.wce-cell-field { flex: 1 1 6rem; }
.wce-cell-op { flex: 0 0 9rem; }
.wce-cell-value { flex: 1 1 6rem; }
.wce-lbl {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dim);
}
.wce-field {
  height: var(--row-h);
  padding: 0 0.5ch;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
  width: 100%;
  box-sizing: border-box;
}

.wce-remove {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--danger);
  cursor: pointer;
  font-size: var(--fs-micro);
  padding: 0 0.3ch;
  height: var(--row-h);
  line-height: var(--row-h);
}
.wce-remove:hover { color: var(--fg); background: var(--danger); }

.wce-add {
  align-self: flex-start;
  background: none;
  border: 1px dashed var(--border);
  color: var(--fg-dim);
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
  height: var(--row-h);
  padding: 0 1ch;
  cursor: pointer;
}
.wce-add:hover { border-color: var(--accent); color: var(--accent); }
</style>
