<script lang="ts">
// Exported types and helpers — import from this file wherever AgentRunnerCard data is needed

import type { WhenCondition } from '@ia-flow/shared'

export type ConditionOp = '=' | '!=' | '$null' | '$not_null'
// logic: conector con la condición ANTERIOR (undefined / 'and' en la primera)
export interface AgentCondition { field: string; op: ConditionOp; value: string; logic: 'and' | 'or' }
export interface FieldAssignment { field: string; value: string }

export interface AgentRunnerEntry {
  agent: string
  conditions: AgentCondition[]
  onProcess: FieldAssignment[]
  onFinish: FieldAssignment[]
  onError: FieldAssignment[]
}

export interface ProjectField { name: string; dataType: string; options: string[] }

// AgentCondition[] → WhenCondition[] (new array format)
export function entryToWhen(conditions: AgentCondition[]): WhenCondition[] {
  return conditions
    .filter(c => c.field.trim())
    .map((c, i) => {
      const entry: WhenCondition = { field: c.field.trim(), op: c.op }
      if (c.op === '=' || c.op === '!=') entry.value = c.value.trim()
      if (i > 0) entry.logic = c.logic
      return entry
    })
}

// WhenCondition[] | Record<string,string> | undefined → AgentCondition[]
export function whenToConditions(
  when: WhenCondition[] | Record<string, string> | undefined
): AgentCondition[] {
  if (!when) return []

  // legacy Record format → all-AND
  if (!Array.isArray(when)) {
    return Object.entries(when).map(([field, raw]) => {
      if (raw === '$null')        return { field, op: '$null' as ConditionOp,     value: '', logic: 'and' as const }
      if (raw === '$not_null')    return { field, op: '$not_null' as ConditionOp, value: '', logic: 'and' as const }
      if (raw.startsWith('$ne:')) return { field, op: '!=' as ConditionOp,        value: raw.slice(4), logic: 'and' as const }
      return { field, op: '=' as ConditionOp, value: raw, logic: 'and' as const }
    })
  }

  // new array format
  return when.map((c, i) => ({
    field: c.field,
    op: c.op as ConditionOp,
    value: c.value ?? '',
    logic: (i === 0 ? 'and' : (c.logic ?? 'and')) as 'and' | 'or',
  }))
}

// "$set:field1=val1,field2=val2" ↔ FieldAssignment[]
export function serializeAssignments(assignments: FieldAssignment[]): string {
  const pairs = assignments.filter(a => a.field.trim())
  if (!pairs.length) return ''
  return '$set:' + pairs.map(a => `${a.field.trim()}=${a.value.trim()}`).join(',')
}

export function deserializeAssignments(raw: string | undefined): FieldAssignment[] {
  if (!raw) return []
  if (raw.startsWith('$set:')) {
    return raw.slice(5).split(',').map(pair => {
      const eq = pair.indexOf('=')
      return eq >= 0
        ? { field: pair.slice(0, eq), value: pair.slice(eq + 1) }
        : { field: pair, value: '' }
    }).filter(a => a.field)
  }
  return [{ field: 'status', value: raw }]
}

export function emptyEntry(defaultAgent = ''): AgentRunnerEntry {
  return { agent: defaultAgent, conditions: [], onProcess: [], onFinish: [], onError: [] }
}
</script>

<script setup lang="ts">
// ─── Component ────────────────────────────────────────────────────────────────

const props = defineProps<{
  modelValue: AgentRunnerEntry
  agentIds: string[]
  projectFields?: ProjectField[]
  statusOptions?: string[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: AgentRunnerEntry]
  remove: []
}>()

function update(patch: Partial<AgentRunnerEntry>) {
  emit('update:modelValue', { ...props.modelValue, ...patch })
}

function fieldNames(): string[] {
  return (props.projectFields ?? []).map(f => f.name)
}

function allFieldNames(): string[] {
  const pf = fieldNames()
  // always offer 'status' as an option even if not in projectFields
  return pf.length ? pf : ['status']
}

function optionsFor(fieldName: string): string[] {
  if (fieldName.toLowerCase() === 'status') return props.statusOptions ?? []
  return (props.projectFields ?? []).find(
    f => f.name.toLowerCase() === fieldName.toLowerCase()
  )?.options ?? []
}

// ── Conditions ──────────────────────────────────────────────────────────────

function addCondition() {
  update({ conditions: [...props.modelValue.conditions, { field: '', op: '=', value: '', logic: 'and' }] })
}

function removeCondition(i: number) {
  update({ conditions: props.modelValue.conditions.filter((_, idx) => idx !== i) })
}

function updateCondition(i: number, patch: Partial<AgentCondition>) {
  update({
    conditions: props.modelValue.conditions.map((c, idx) => idx === i ? { ...c, ...patch } : c),
  })
}

function toggleConditionLogic(i: number) {
  const current = props.modelValue.conditions[i]?.logic ?? 'and'
  updateCondition(i, { logic: current === 'and' ? 'or' : 'and' })
}

// ── Transitions ──────────────────────────────────────────────────────────────

type TransKey = 'onProcess' | 'onFinish' | 'onError'

function addAssignment(key: TransKey) {
  update({ [key]: [...props.modelValue[key], { field: '', value: '' }] })
}

function removeAssignment(key: TransKey, i: number) {
  update({ [key]: props.modelValue[key].filter((_, idx) => idx !== i) })
}

function updateAssignment(key: TransKey, i: number, patch: Partial<FieldAssignment>) {
  update({
    [key]: props.modelValue[key].map((a, idx) => idx === i ? { ...a, ...patch } : a),
  })
}
</script>

<template>
  <div class="runner-card">
    <!-- ── Header: agent selector + remove ────────────────────────── -->
    <div class="runner-head">
      <div class="agent-row">
        <select
          :value="modelValue.agent"
          class="input select agent-select"
          @change="update({ agent: ($event.target as HTMLSelectElement).value })"
        >
          <option v-for="id in agentIds" :key="id" :value="id">{{ id }}</option>
        </select>
        <span v-if="!modelValue.conditions.length" class="default-badge">default</span>
      </div>
      <button class="remove-btn" title="Eliminar agente" @click="emit('remove')">✕</button>
    </div>

    <!-- ── Conditions ─────────────────────────────────────────────── -->
    <div class="conditions">
      <template v-for="(c, ci) in modelValue.conditions" :key="ci">
        <div v-if="ci > 0" class="logic-row">
          <button
            class="logic-badge"
            :class="c.logic ?? 'and'"
            :title="`Conector: ${(c.logic ?? 'and').toUpperCase()} — clic para cambiar`"
            @click="toggleConditionLogic(ci)"
          >{{ (c.logic ?? 'and').toUpperCase() }}</button>
        </div>
        <div class="cond-row">
          <select
            v-if="fieldNames().length"
            :value="c.field"
            class="input select cond-field"
            @change="updateCondition(ci, { field: ($event.target as HTMLSelectElement).value })"
          >
            <option value="" disabled>— Campo —</option>
            <option v-for="fn in fieldNames()" :key="fn" :value="fn">{{ fn }}</option>
          </select>
          <input
            v-else
            :value="c.field"
            class="input cond-field"
            placeholder="type"
            @input="updateCondition(ci, { field: ($event.target as HTMLInputElement).value })"
          />

          <select
            :value="c.op"
            class="input select cond-op"
            @change="updateCondition(ci, { op: ($event.target as HTMLSelectElement).value as ConditionOp, value: '' })"
          >
            <option value="=">= igual</option>
            <option value="!=">!= distinto</option>
            <option value="$null">es nulo</option>
            <option value="$not_null">no es nulo</option>
          </select>

          <template v-if="c.op === '=' || c.op === '!='">
            <select
              v-if="optionsFor(c.field).length"
              :value="c.value"
              class="input select cond-value"
              @change="updateCondition(ci, { value: ($event.target as HTMLSelectElement).value })"
            >
              <option value="" disabled>— Valor —</option>
              <option v-for="opt in optionsFor(c.field)" :key="opt" :value="opt">{{ opt }}</option>
            </select>
            <input
              v-else
              :value="c.value"
              class="input cond-value"
              placeholder="technical"
              @input="updateCondition(ci, { value: ($event.target as HTMLInputElement).value })"
            />
          </template>

          <button class="remove-btn small" @click="removeCondition(ci)">✕</button>
        </div>
      </template>
      <button class="btn-add" @click="addCondition">+ Condición</button>
    </div>

    <!-- ── Transitions ────────────────────────────────────────────── -->
    <div class="transitions">
      <template v-for="(key, ki) in (['onProcess', 'onFinish', 'onError'] as const)" :key="key">
        <hr v-if="ki > 0" class="trans-sep" />
        <div class="trans-section">
          <div class="trans-head">
            <span class="trans-label">{{ key === 'onProcess' ? 'En proceso' : key === 'onFinish' ? 'Al terminar' : 'Al fallar' }}</span>
            <button class="btn-add-assign" @click="addAssignment(key)">+ Campo</button>
          </div>
          <div v-for="(a, ai) in modelValue[key]" :key="ai" class="assign-row">
            <select
              v-if="allFieldNames().length"
              :value="a.field"
              class="input select assign-field"
              @change="updateAssignment(key, ai, { field: ($event.target as HTMLSelectElement).value, value: '' })"
            >
              <option value="" disabled>— Campo —</option>
              <option v-for="fn in allFieldNames()" :key="fn" :value="fn">{{ fn }}</option>
            </select>
            <input
              v-else
              :value="a.field"
              class="input assign-field"
              placeholder="status"
              @input="updateAssignment(key, ai, { field: ($event.target as HTMLInputElement).value })"
            />
            <span class="assign-sep">:</span>
            <select
              v-if="optionsFor(a.field).length"
              :value="a.value"
              class="input select assign-value"
              @change="updateAssignment(key, ai, { value: ($event.target as HTMLSelectElement).value })"
            >
              <option value="" disabled>— Valor —</option>
              <option v-for="opt in optionsFor(a.field)" :key="opt" :value="opt">{{ opt }}</option>
            </select>
            <input
              v-else
              :value="a.value"
              class="input assign-value"
              placeholder="valor"
              @input="updateAssignment(key, ai, { value: ($event.target as HTMLInputElement).value })"
            />
            <button class="remove-btn small" @click="removeAssignment(key, ai)">✕</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.runner-card {
  border: 1px solid #e9d5ff;
  border-radius: 8px;
  padding: 0.65rem 0.8rem;
  background: #faf5ff;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

/* ── Header ── */
.runner-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.agent-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1;
  min-width: 0;
}
.agent-select { flex: 1; min-width: 0; }
.default-badge {
  flex-shrink: 0;
  font-size: 0.65rem;
  font-weight: 600;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
  background: #d1fae5;
  color: #065f46;
}

/* ── Conditions ── */
.conditions {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.logic-row { display: flex; align-items: center; }
.logic-badge {
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  border-radius: 4px;
  padding: 0.1rem 0.4rem;
  margin-left: 0.1rem;
  cursor: pointer;
  border: 1px solid;
  line-height: 1.4;
  transition: background 0.15s, color 0.15s;
}
.logic-badge.and { color: #7c3aed; background: #ede9fe; border-color: #ddd6fe; }
.logic-badge.and:hover { background: #ddd6fe; }
.logic-badge.or  { color: #b45309; background: #fef3c7; border-color: #fde68a; }
.logic-badge.or:hover  { background: #fde68a; }

.cond-row { display: flex; align-items: center; gap: 0.3rem; }
.cond-field { flex: 1 1 5rem; min-width: 0; }
.cond-op    { flex: 0 0 8rem; }
.cond-value { flex: 1 1 6rem; min-width: 0; }

/* ── Transitions ── */
.transitions {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding-top: 0.5rem;
  border-top: 1px solid #e9d5ff;
}
.trans-sep {
  border: none;
  border-top: 1px dashed #e9d5ff;
  margin: 0;
}
.trans-section {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.trans-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.trans-label {
  font-size: 0.7rem;
  color: #6b7280;
  font-weight: 500;
}
.assign-row {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.assign-field { flex: 1 1 0; min-width: 0; }
.assign-sep   { font-size: 0.78rem; color: #9ca3af; flex-shrink: 0; }
.assign-value { flex: 1 1 0; min-width: 0; }

/* ── Shared inputs ── */
.input {
  padding: 0.4rem 0.6rem;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 0.84rem;
  color: #1e293b;
  background: #fff;
  width: 100%;
  box-sizing: border-box;
  outline: none;
}
.input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
.select { cursor: pointer; }

.remove-btn {
  flex-shrink: 0;
  background: none;
  border: none;
  color: #ef4444;
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0.1rem 0.3rem;
  line-height: 1;
  opacity: 0.7;
}
.remove-btn:hover { opacity: 1; }
.remove-btn.small { font-size: 0.72rem; }

.btn-add {
  align-self: flex-start;
  background: none;
  border: 1px dashed #d1d5db;
  border-radius: 5px;
  color: #6b7280;
  font-size: 0.78rem;
  padding: 0.25rem 0.6rem;
  cursor: pointer;
}
.btn-add:hover { border-color: #2563eb; color: #2563eb; }

.btn-add-assign {
  background: none;
  border: 1px dashed #d1d5db;
  border-radius: 5px;
  color: #6b7280;
  font-size: 0.72rem;
  padding: 0.2rem 0.5rem;
  cursor: pointer;
  white-space: nowrap;
}
.btn-add-assign:hover { border-color: #2563eb; color: #2563eb; }
</style>
