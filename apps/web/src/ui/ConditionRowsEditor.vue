<script setup lang="ts">
import type { ConditionRow } from './condition-rows'

// Filas "campo · operador · valor", sin dominio.
//
// Existe porque hay TRES lenguajes de condiciones en el sistema y se editan
// igual aunque no signifiquen lo mismo: el `when` de un agente (DSL del
// engine, evaluado contra los campos del issue), el `when` de una regla (el
// mismo DSL, contra el payload del evento) y las reglas de admisión de un
// agent-host (`equals|matches|…` sobre lo que la tarea trae). Como viven en
// features distintas —y una feature no puede importar de otra— la fila
// compartida sube acá, que es lo que el layout de esta app manda hacer.
//
// Hasta hace poco había DOS componentes para esto: éste y
// `features/agents/WhenConditionsEditor.vue`, con el CSS clonado casi byte a
// byte y las capacidades repartidas entre los dos —el badge AND/OR y el
// catálogo de valores por campo sólo en el de agentes, el input de campo libre
// sólo acá—. Ahora todo eso son props: quien no las pasa no las paga.
//
// No sabe qué campos ni qué operadores existen: los recibe. Lo único que
// impone es la forma de la fila y su lenguaje visual, que es el kit compartido
// (`ui/form-fields.css`).

const props = withDefaults(
  defineProps<{
    modelValue: ConditionRow[]
    /** Opciones del select de campo. Vacío = input libre. */
    fields?: readonly string[]
    ops: readonly { value: string; label: string }[]
    /** Sugerencias de valor para una fila. Vacío = input libre. Recibe la
     *  fila entera y no sólo el campo porque el catálogo no siempre aplica:
     *  un `$matches` o un `>` toman una regex o un número, no un valor de la
     *  lista, y ahí el consumidor devuelve vacío para que se edite a mano. */
    valueOptions?: (row: ConditionRow) => readonly string[]
    /** Ops unarios (`$null`) no llevan valor y le esconden el campo. */
    opTakesValue?: (op: string) => boolean
    fieldPlaceholder?: string
    /** Un string, o una función del operador cuando el ejemplo útil depende de
     *  él (una regex no se ejemplifica como un número). */
    valuePlaceholder?: string | ((op: string) => string)
    addLabel?: string
    /** Muestra el badge AND/OR entre filas y escribe `logic` en la fila. */
    logic?: boolean
    /** Qué fila nace al agregar — el default toma el primer campo y operador. */
    emptyRow?: () => ConditionRow
  }>(),
  {
    fields: () => [],
    valueOptions: () => [],
    opTakesValue: () => true,
    fieldPlaceholder: undefined,
    valuePlaceholder: 'valor',
    addLabel: '+ condición',
    logic: false,
    emptyRow: undefined,
  },
)

const emit = defineEmits<{ 'update:modelValue': [value: ConditionRow[]] }>()

// El catálogo del consumidor no siempre cubre lo que el motor sabe evaluar (un
// campo guardado a mano vía API, un source que todavía no lo publica en
// getFields, una label borrada). Sin agregarlo a las opciones, el <select>
// nativo muestra la fila vacía y el primer cambio de operador se lleva puesta
// la condición sin que el usuario vea qué perdió.
function fieldNames(current?: string): string[] {
  const names = [...props.fields]
  if (current && !names.some((n) => eq(n, current))) names.push(current)
  return names
}

function valuesFor(row: ConditionRow): string[] {
  const opts = [...props.valueOptions(row)]
  if (!opts.length) return []
  if (row.value && !opts.some((o) => eq(o, row.value))) opts.push(row.value)
  return opts
}

// Los motores matchean campo y valor case-insensitive (ver `selectAgent`), así
// que una condición guardada como "status"/"backlog" es tan válida como
// "Status"/"Backlog". Pero el <select> nativo sólo resalta una <option> si su
// value calza EXACTO — sin esto, recargar una condición con otra
// capitalización que la del catálogo actual la mostraba vacía.
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const resolve = (options: string[], current: string) =>
  options.find((o) => eq(o, current)) ?? current

function placeholderFor(op: string): string {
  return typeof props.valuePlaceholder === 'function'
    ? props.valuePlaceholder(op)
    : props.valuePlaceholder
}

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

function toggleLogic(i: number): void {
  update(i, { logic: (props.modelValue[i]?.logic ?? 'and') === 'and' ? 'or' : 'and' })
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
    <template v-for="(row, i) in modelValue" :key="i">
      <div v-if="logic && i > 0" class="cre-logic-row">
        <button
          type="button"
          class="cre-logic"
          :class="row.logic ?? 'and'"
          :title="`Conector: ${(row.logic ?? 'and').toUpperCase()} — clic para cambiar`"
          @click="toggleLogic(i)"
        >{{ (row.logic ?? 'and').toUpperCase() }}</button>
      </div>

      <div class="cre-row">
        <div class="cre-cell cre-cell--field">
          <span class="uc-label">Campo</span>
          <select
            v-if="fields.length"
            :value="resolve(fieldNames(row.field), row.field)"
            class="ff-field ff-mono"
            @change="update(i, { field: ($event.target as HTMLSelectElement).value, value: '' })"
          >
            <option value="" disabled>— Campo —</option>
            <option v-for="f in fieldNames(row.field)" :key="f" :value="f">{{ f }}</option>
          </select>
          <input
            v-else
            :value="row.field"
            class="ff-field ff-mono"
            :placeholder="fieldPlaceholder"
            @input="update(i, { field: ($event.target as HTMLInputElement).value })"
          />
        </div>

        <div class="cre-cell cre-cell--op">
          <span class="uc-label">Operador</span>
          <select
            :value="row.op"
            class="ff-field"
            @change="update(i, { op: ($event.target as HTMLSelectElement).value, value: '' })"
          >
            <option v-for="o in ops" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>

        <div v-if="opTakesValue(row.op)" class="cre-cell cre-cell--value">
          <span class="uc-label">Valor</span>
          <select
            v-if="valuesFor(row).length"
            :value="resolve(valuesFor(row), row.value)"
            class="ff-field ff-mono"
            @change="update(i, { value: ($event.target as HTMLSelectElement).value })"
          >
            <option value="" disabled>— Valor —</option>
            <option v-for="opt in valuesFor(row)" :key="opt" :value="opt">{{ opt }}</option>
          </select>
          <input
            v-else
            :value="row.value"
            class="ff-field ff-mono"
            :placeholder="placeholderFor(row.op)"
            @input="update(i, { value: ($event.target as HTMLInputElement).value })"
          />
        </div>

        <button type="button" class="ff-drop" aria-label="Quitar condición" @click="remove(i)">
          ✕
        </button>
      </div>
    </template>

    <button type="button" class="ff-add" @click="add">{{ addLabel }}</button>
  </div>
</template>

<style scoped src="@/ui/form-fields.css"></style>
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

/* El conector va ENTRE las dos filas que une, no en una tira aparte debajo de
   todas: pertenece a un par concreto, y agrupado se vuelve un acertijo de
   índices ("¿el segundo AND es entre la 2 y la 3?"). */
.cre-logic-row {
  display: flex;
  align-items: center;
}
.cre-logic {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  font-weight: 700;
  letter-spacing: var(--tracking-lbl);
  padding: 0 0.4ch;
  height: var(--row-h);
  line-height: var(--row-h);
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--panel-alt);
  border-radius: var(--radius-sm);
}
.cre-logic.and {
  color: var(--ai);
  border-color: var(--ai);
}
.cre-logic.or {
  color: var(--warn);
  border-color: var(--warn);
  background: var(--yellow-bg);
}
</style>
