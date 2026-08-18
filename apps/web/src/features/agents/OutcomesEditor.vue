<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import type { AgentOutcomes } from '@ia-flow/shared'
import {
  formToOutcomes,
  type LabelAction,
  type LabelOps,
  outcomesToForm,
  type OutcomesFormValue,
  type ProjectField,
} from '@/features/agents/outcomes-serialization'

// v-model over the AgentOutcomes subset of AgentDefinition — qué escribe el
// agente de vuelta al issue al arrancar (onProcess) / terminar ok (onFinish)
// / fallar (onError), como asignaciones `$set:` de campos y operaciones
// `$labels:` sobre las labels del issue.

const props = defineProps<{
  modelValue: AgentOutcomes
  projectFields?: ProjectField[]
  statusOptions?: string[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: AgentOutcomes): void
}>()

const form = ref<OutcomesFormValue>(outcomesToForm(props.modelValue))

watch(
  () => props.modelValue,
  (next) => {
    form.value = outcomesToForm(next)
  },
)

function emitForm(next: OutcomesFormValue) {
  form.value = next
  emit('update:modelValue', formToOutcomes(next))
}

function fieldNames(): string[] {
  return (props.projectFields ?? []).map((f) => f.name)
}

function allFieldNames(): string[] {
  const pf = fieldNames()
  return pf.length ? pf : ['status']
}

function optionsFor(fieldName: string): string[] {
  if (fieldName.toLowerCase() === 'status') return props.statusOptions ?? []
  return (
    (props.projectFields ?? []).find((f) => f.name.toLowerCase() === fieldName.toLowerCase())
      ?.options ?? []
  )
}

type TransKey = 'onProcess' | 'onFinish' | 'onError'
type LabelsKey = 'onProcessLabels' | 'onFinishLabels' | 'onErrorLabels'

const TRANSITIONS: { key: TransKey; labelsKey: LabelsKey; label: string }[] = [
  { key: 'onProcess', labelsKey: 'onProcessLabels', label: 'Al arrancar' },
  { key: 'onFinish', labelsKey: 'onFinishLabels', label: 'Al terminar OK' },
  { key: 'onError', labelsKey: 'onErrorLabels', label: 'Al fallar' },
]

function addAssignment(key: TransKey) {
  emitForm({ ...form.value, [key]: [...form.value[key], { field: '', value: '' }] })
}

function removeAssignment(key: TransKey, i: number) {
  emitForm({ ...form.value, [key]: form.value[key].filter((_, idx) => idx !== i) })
}

function updateAssignment(key: TransKey, i: number, patch: Partial<{ field: string; value: string }>) {
  emitForm({
    ...form.value,
    [key]: form.value[key].map((a, idx) => (idx === i ? { ...a, ...patch } : a)),
  })
}

const LABEL_ACTIONS: { action: LabelAction; label: string; hint: string }[] = [
  { action: 'add', label: 'Añadir', hint: 'label' },
  { action: 'remove', label: 'Quitar', hint: 'label' },
  { action: 'replace', label: 'Reemplazar por', hint: 'label' },
]

// In-progress input per outcome × action. Not part of the model so text a
// user hasn't committed to a chip doesn't leak into the emitted patch.
const drafts = reactive<Record<LabelsKey, Record<LabelAction, string>>>({
  onProcessLabels: { add: '', remove: '', replace: '' },
  onFinishLabels: { add: '', remove: '', replace: '' },
  onErrorLabels: { add: '', remove: '', replace: '' },
})

function updateLabelOps(key: LabelsKey, patch: Partial<LabelOps>) {
  emitForm({ ...form.value, [key]: { ...form.value[key], ...patch } })
}

function commitDraft(key: LabelsKey, action: LabelAction) {
  const raw = drafts[key][action]
  if (!raw) return
  // Support paste-with-commas: "a, b, c" → 3 chips.
  const tokens = raw.split(',').map((t) => t.trim()).filter(Boolean)
  if (!tokens.length) {
    drafts[key][action] = ''
    return
  }
  const current = form.value[key][action]
  const merged = [...current]
  for (const t of tokens) {
    if (!merged.includes(t)) merged.push(t)
  }
  updateLabelOps(key, { [action]: merged } as Partial<LabelOps>)
  drafts[key][action] = ''
}

function removeChip(key: LabelsKey, action: LabelAction, i: number) {
  const list = form.value[key][action]
  updateLabelOps(key, { [action]: list.filter((_, idx) => idx !== i) } as Partial<LabelOps>)
}

function onDraftKeydown(e: KeyboardEvent, key: LabelsKey, action: LabelAction) {
  // Enter or comma commits the current draft into a chip.
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault()
    commitDraft(key, action)
  }
}

function labelsCount(ops: LabelOps): number {
  return ops.add.length + ops.remove.length + ops.replace.length
}
</script>

<template>
  <div class="oe">
    <template v-for="(t, ki) in TRANSITIONS" :key="t.key">
      <div v-if="ki > 0" class="oe-sep" />
      <div class="oe-slot">
        <span class="uc-label oe-slot-label">{{ t.label }}</span>

        <!-- ── Campos ($set:) ─────────────────────────────────── -->
        <div class="oe-sub">
          <div class="oe-sub-head">
            <span class="uc-label">Campos</span>
            <button type="button" class="oe-add" @click="addAssignment(t.key)">+ campo</button>
          </div>
          <div v-for="(a, ai) in form[t.key]" :key="ai" class="oe-assign-row">
            <select
              v-if="allFieldNames().length"
              :value="a.field"
              class="oe-field oe-assign-field"
              @change="updateAssignment(t.key, ai, { field: ($event.target as HTMLSelectElement).value, value: '' })"
            >
              <option value="" disabled>— Campo —</option>
              <option v-for="fn in allFieldNames()" :key="fn" :value="fn">{{ fn }}</option>
            </select>
            <input
              v-else
              :value="a.field"
              class="oe-field oe-assign-field"
              placeholder="status"
              @input="updateAssignment(t.key, ai, { field: ($event.target as HTMLInputElement).value })"
            />
            <span class="oe-assign-sep">:</span>
            <select
              v-if="optionsFor(a.field).length"
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

        <!-- ── Labels ($labels:) ──────────────────────────────── -->
        <div class="oe-sub" :class="{ 'oe-sub--empty': labelsCount(form[t.labelsKey]) === 0 }">
          <div class="oe-sub-head">
            <span class="uc-label">Labels</span>
          </div>
          <div v-for="a in LABEL_ACTIONS" :key="a.action" class="oe-label-row">
            <span class="oe-action-label" :data-action="a.action">{{ a.label }}</span>
            <div class="oe-chips">
              <span
                v-for="(chip, ci) in form[t.labelsKey][a.action]"
                :key="`${a.action}-${ci}`"
                class="oe-chip"
                :data-action="a.action"
              >
                {{ chip }}
                <button
                  type="button"
                  class="oe-chip-x"
                  :aria-label="`Quitar ${chip}`"
                  @click="removeChip(t.labelsKey, a.action, ci)"
                >✕</button>
              </span>
              <input
                v-model="drafts[t.labelsKey][a.action]"
                class="oe-chip-input"
                :placeholder="a.hint"
                :data-labels-input="`${t.labelsKey}.${a.action}`"
                @keydown="onDraftKeydown($event, t.labelsKey, a.action)"
                @blur="commitDraft(t.labelsKey, a.action)"
              />
            </div>
          </div>
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

.oe-sub {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding-left: 0.6rem;
  border-left: 2px solid var(--border-mute);
}
.oe-sub-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
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

/* ── Label chips ── */
.oe-label-row {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  padding: 0.1rem 0;
}
.oe-action-label {
  flex-shrink: 0;
  font-size: var(--fs-micro);
  color: var(--fg-dim);
  padding-top: 0.3rem;
  min-width: 6.5rem;
}
.oe-action-label[data-action='add'] { color: var(--accent); }
.oe-action-label[data-action='remove'] { color: var(--danger); }
.oe-action-label[data-action='replace'] { color: var(--warn); }

.oe-chips {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: center;
  min-height: var(--row-h);
  padding: 0.1rem 0.2rem;
  border: 1px dashed var(--border);
  background: var(--panel);
}
.oe-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  font-size: var(--fs-micro);
  padding: 0 0.5ch;
  height: var(--row-h);
  line-height: var(--row-h);
  background: var(--panel-hi);
  color: var(--fg-mute);
  border: 1px solid var(--border);
}
.oe-chip[data-action='add'] { color: var(--accent); border-color: var(--accent); }
.oe-chip[data-action='remove'] { color: var(--danger); border-color: var(--danger); }
.oe-chip[data-action='replace'] { color: var(--warn); border-color: var(--warn); }
.oe-chip-x {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: var(--fs-micro);
  padding: 0;
  line-height: 1;
  opacity: 0.7;
}
.oe-chip-x:hover { opacity: 1; }
.oe-chip-input {
  flex: 1 1 4rem;
  min-width: 4rem;
  border: none;
  outline: none;
  background: transparent;
  padding: 0 0.25rem;
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
  color: var(--fg);
  height: var(--row-h);
}
</style>
