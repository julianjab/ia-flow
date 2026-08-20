<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { MULTI_SELECT_DATA_TYPE, type AgentOutcomes } from '@ia-flow/shared'
import LabelOpsEditor from '@/features/agents/LabelOpsEditor.vue'
import {
  formToOutcomes,
  isLabelsField,
  LABELS_FIELD,
  outcomesToForm,
  type OutcomesFormValue,
  type ProjectField,
} from '@/features/agents/outcomes-serialization'

// v-model over the AgentOutcomes subset of AgentDefinition — qué escribe el
// agente de vuelta al issue al arrancar (onProcess) / terminar ok (onFinish)
// / fallar (onError).
//
// Una sola lista por slot: cada fila es "campo : valor". `Labels` es un campo
// más, y su valor son tokens con signo (`+design,-wip`) — no hay una sección
// aparte con filas fijas de Añadir/Quitar/Reemplazar.

const props = defineProps<{
  modelValue: AgentOutcomes
  projectFields?: ProjectField[]
  statusOptions?: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: AgentOutcomes): void
}>()

const form = ref<OutcomesFormValue>(outcomesToForm(props.modelValue))

// Igual que en WhenConditionsEditor: una fila recién agregada nace vacía y
// `formToOutcomes` la filtra al serializar, así que el padre nos devuelve un
// valor sin ella. Sin recordar lo último emitido, el watcher borraría la fila
// antes de que el usuario llegue a elegir el campo — el botón "+ campo" no
// haría nada visible.
let lastEmitted: string | null = null

watch(
  () => props.modelValue,
  (next) => {
    if (JSON.stringify(next ?? {}) === lastEmitted) return
    form.value = outcomesToForm(next)
  },
)

function emitForm(next: OutcomesFormValue) {
  form.value = next
  const outcomes = formToOutcomes(next)
  lastEmitted = JSON.stringify(outcomes)
  emit('update:modelValue', outcomes)
}

// El catálogo de campos del proyecto ya incluye `Labels` (lo deriva el
// server). Si no hay catálogo, ofrecemos al menos status y labels para que el
// editor siga siendo usable sin fuente.
const fieldNames = computed(() => {
  const names = (props.projectFields ?? []).map((f) => f.name)
  if (!names.length) return ['status', LABELS_FIELD]
  return names.some((n) => isLabelsField(n)) ? names : [...names, LABELS_FIELD]
})

const labelOptions = computed(
  () => props.projectFields?.find((f) => isLabelsField(f.name))?.options ?? [],
)

// Qué fila se edita con tokens con signo: lo decide la DEFINICIÓN del campo
// (`dataType: MULTI_SELECT`, que el source publica en getFields), no su
// nombre. El fallback por nombre cubre el caso sin catálogo — un proyecto
// recién creado, o un source que no implementa getFields — donde igual hay
// que poder editar `Labels`.
const multiValueFields = computed(
  () =>
    new Set(
      (props.projectFields ?? [])
        .filter((f) => f.dataType === MULTI_SELECT_DATA_TYPE)
        .map((f) => f.name.trim().toLowerCase()),
    ),
)

function isMultiValueField(field: string): boolean {
  return multiValueFields.value.has(field.trim().toLowerCase()) || isLabelsField(field)
}

function optionsFor(fieldName: string): string[] {
  if (fieldName.toLowerCase() === 'status') return props.statusOptions ?? []
  return (
    (props.projectFields ?? []).find((f) => f.name.toLowerCase() === fieldName.toLowerCase())
      ?.options ?? []
  )
}

type TransKey = 'onProcess' | 'onFinish' | 'onError'

const TRANSITIONS: { key: TransKey; label: string }[] = [
  { key: 'onProcess', label: 'Al arrancar' },
  { key: 'onFinish', label: 'Al terminar OK' },
  { key: 'onError', label: 'Al fallar' },
]

function addAssignment(key: TransKey) {
  emitForm({ ...form.value, [key]: [...form.value[key], { field: '', value: '' }] })
}

function removeAssignment(key: TransKey, i: number) {
  emitForm({ ...form.value, [key]: form.value[key].filter((_, idx) => idx !== i) })
}

function updateAssignment(
  key: TransKey,
  i: number,
  patch: Partial<{ field: string; value: string }>,
) {
  emitForm({
    ...form.value,
    [key]: form.value[key].map((a, idx) => (idx === i ? { ...a, ...patch } : a)),
  })
}
</script>

<template>
  <div class="oe">
    <template v-for="(t, ki) in TRANSITIONS" :key="t.key">
      <div v-if="ki > 0" class="oe-sep" />
      <div class="oe-slot">
        <div class="oe-slot-head">
          <span class="uc-label oe-slot-label">{{ t.label }}</span>
          <button type="button" class="oe-add" @click="addAssignment(t.key)">+ campo</button>
        </div>

        <p v-if="!form[t.key].length" class="oe-empty">Sin cambios en esta transición.</p>

        <div v-for="(a, ai) in form[t.key]" :key="ai" class="oe-assign-row">
          <select
            :value="a.field"
            class="oe-field oe-assign-field"
            @change="updateAssignment(t.key, ai, { field: ($event.target as HTMLSelectElement).value, value: '' })"
          >
            <option value="" disabled>— Campo —</option>
            <option v-for="fn in fieldNames" :key="fn" :value="fn">{{ fn }}</option>
          </select>
          <span class="oe-assign-sep">:</span>

          <!-- Labels: el valor son tokens con signo, no un valor único. -->
          <LabelOpsEditor
            v-if="isMultiValueField(a.field)"
            :model-value="a.value"
            :options="labelOptions"
            @update:model-value="updateAssignment(t.key, ai, { value: $event })"
          />
          <select
            v-else-if="optionsFor(a.field).length"
            :value="a.value"
            class="oe-field oe-assign-value"
            @change="updateAssignment(t.key, ai, { value: ($event.target as HTMLSelectElement).value })"
          >
            <option value="" disabled>— Valor —</option>
            <option v-for="opt in optionsFor(a.field)" :key="opt" :value="opt">{{ opt }}</option>
          </select>
          <input
            v-else
            :value="a.value"
            class="oe-field oe-assign-value"
            placeholder="valor"
            @input="updateAssignment(t.key, ai, { value: ($event.target as HTMLInputElement).value })"
          />

          <button
            type="button"
            class="oe-remove"
            aria-label="Quitar campo"
            @click="removeAssignment(t.key, ai)"
          >✕</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.oe {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.oe-sep {
  border-top: 1px dashed var(--border-mute);
}
.oe-slot {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding-top: 0.4rem;
}
.oe-slot-label { color: var(--fg-mute); }
.oe-slot-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.oe-empty {
  margin: 0;
  font-size: var(--fs-micro);
  color: var(--fg-dimmer);
}

.oe-assign-row { display: flex; align-items: center; gap: 0.3rem; }
.oe-field {
  height: var(--row-h);
  padding: 0 0.5ch;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: var(--fs-body-sm);
}
.oe-assign-field { flex: 1 1 0; min-width: 0; }
.oe-assign-sep { color: var(--fg-dim); flex-shrink: 0; }
.oe-assign-value { flex: 1 1 0; min-width: 0; }

.oe-add {
  background: none;
  border: 1px dashed var(--border);
  color: var(--fg-dim);
  font-size: var(--fs-micro);
  font-family: var(--font-mono);
  height: var(--row-h);
  padding: 0 1ch;
  cursor: pointer;
  white-space: nowrap;
}
.oe-add:hover { border-color: var(--accent); color: var(--accent); }

.oe-remove {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--danger);
  cursor: pointer;
  font-size: var(--fs-micro);
  padding: 0 0.3ch;
  line-height: var(--row-h);
}
.oe-remove:hover { color: var(--fg); background: var(--danger); }

</style>
