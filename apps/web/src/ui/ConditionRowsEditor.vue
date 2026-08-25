<script setup lang="ts">
import type { ConditionRow } from './condition-rows'

// Filas "campo · operador · valor", sin dominio.
//
// Existe porque hay DOS lenguajes de condiciones en el sistema y se editan
// igual aunque no signifiquen lo mismo: el `when` de un agente (DSL del
// engine, evaluado contra los campos del issue) y las reglas de admisión de
// un gateway (`equals|matches|…` sobre lo que la tarea trae). Como viven en
// features distintas —y una feature no puede importar de otra— la fila
// compartida sube acá, que es lo que el layout de esta app manda hacer.
//
// No sabe qué campos ni qué operadores existen: los recibe. Lo único que
// impone es la forma de la fila y su lenguaje visual.

const props = withDefaults(
  defineProps<{
    modelValue: ConditionRow[]
    /** Opciones del select de campo. Vacío = input libre. */
    fields?: readonly string[]
    ops: readonly { value: string; label: string }[]
    /** Sugerencias de valor para un campo dado. Vacío = input libre. */
    valueOptions?: (field: string) => readonly string[]
    valuePlaceholder?: string
    addLabel?: string
    /** Qué fila nace al agregar — el default toma el primer campo y operador. */
    emptyRow?: () => ConditionRow
  }>(),
  {
    fields: () => [],
    valueOptions: () => [],
    valuePlaceholder: 'valor',
    addLabel: '+ condición',
    emptyRow: undefined,
  },
)

const emit = defineEmits<{ 'update:modelValue': [value: ConditionRow[]] }>()

function update(i: number, patch: Partial<ConditionRow>): void {
  emit(
    'update:modelValue',
    props.modelValue.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
  )
}

function remove(i: number): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, idx) => idx !== i),
  )
}

function add(): void {
  const row = props.emptyRow?.() ?? {
    field: props.fields[0] ?? '',
    op: props.ops[0]?.value ?? '',
    value: '',
  }
  emit('update:modelValue', [...props.modelValue, row])
}
</script>

<template>
  <div class="cre">
    <div v-for="(row, i) in modelValue" :key="i" class="cre-row">
      <div class="cre-cell cre-cell--field">
        <span class="cre-lbl">Campo</span>
        <select
          v-if="fields.length"
          :value="row.field"
          class="cre-field"
          @change="update(i, { field: ($event.target as HTMLSelectElement).value, value: '' })"
        >
          <option v-for="f in fields" :key="f" :value="f">{{ f }}</option>
        </select>
        <input
          v-else
          :value="row.field"
          class="cre-field"
          @input="update(i, { field: ($event.target as HTMLInputElement).value })"
        />
      </div>

      <div class="cre-cell cre-cell--op">
        <span class="cre-lbl">Operador</span>
        <select
          :value="row.op"
          class="cre-field"
          @change="update(i, { op: ($event.target as HTMLSelectElement).value })"
        >
          <option v-for="o in ops" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>

      <div class="cre-cell cre-cell--value">
        <span class="cre-lbl">Valor</span>
        <select
          v-if="valueOptions(row.field).length"
          :value="row.value"
          class="cre-field"
          @change="update(i, { value: ($event.target as HTMLSelectElement).value })"
        >
          <option value="" disabled>— Valor —</option>
          <option v-for="opt in valueOptions(row.field)" :key="opt" :value="opt">{{ opt }}</option>
        </select>
        <input
          v-else
          :value="row.value"
          class="cre-field"
          :placeholder="valuePlaceholder"
          @input="update(i, { value: ($event.target as HTMLInputElement).value })"
        />
      </div>

      <button type="button" class="cre-remove" aria-label="Quitar condición" @click="remove(i)">
        ✕
      </button>
    </div>

    <button type="button" class="cre-add" @click="add">{{ addLabel }}</button>
  </div>
</template>

<style scoped>
.cre {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.cre-row {
  display: flex;
  align-items: flex-end;
  gap: 0.4rem;
}
.cre-cell {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.cre-cell--field {
  flex: 1 1 6rem;
}
.cre-cell--op {
  flex: 0 0 9rem;
}
.cre-cell--value {
  flex: 1 1 6rem;
}
.cre-lbl {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: var(--tracking-lbl);
  text-transform: uppercase;
  color: var(--fg-dim);
}
.cre-field {
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
.cre-remove {
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
.cre-remove:hover {
  color: var(--fg);
  background: var(--danger);
}
.cre-add {
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
.cre-add:hover {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
