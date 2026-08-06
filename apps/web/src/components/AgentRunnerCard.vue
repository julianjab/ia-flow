<script lang="ts">
// Exported types and helpers — import from this file wherever AgentRunnerCard data is needed

export type ConditionOp = '=' | '$null' | '$not_null'
export interface AgentCondition { field: string; op: ConditionOp; value: string }
export interface AgentRunnerEntry {
  agent: string
  conditions: AgentCondition[]
  onProcess: string
  onFinish: string
  onError: string
}
export interface ProjectField { name: string; dataType: string; options: string[] }

export function entryToWhen(conditions: AgentCondition[]): Record<string, string> {
  return Object.fromEntries(
    conditions
      .filter(c => c.field.trim())
      .map(c => [c.field.trim(), c.op === '=' ? c.value.trim() : c.op])
  )
}

export function whenToConditions(when: Record<string, string> | undefined): AgentCondition[] {
  return Object.entries(when ?? {}).map(([field, raw]) => {
    if (raw === '$null')     return { field, op: '$null' as ConditionOp,     value: '' }
    if (raw === '$not_null') return { field, op: '$not_null' as ConditionOp, value: '' }
    return { field, op: '=' as ConditionOp, value: raw }
  })
}

export function emptyEntry(defaultAgent = ''): AgentRunnerEntry {
  return { agent: defaultAgent, conditions: [], onProcess: '', onFinish: '', onError: '' }
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

function optionsFor(fieldName: string): string[] {
  return (props.projectFields ?? []).find(
    f => f.name.toLowerCase() === fieldName.toLowerCase()
  )?.options ?? []
}

function addCondition() {
  update({ conditions: [...props.modelValue.conditions, { field: '', op: '=', value: '' }] })
}

function removeCondition(i: number) {
  const conditions = props.modelValue.conditions.filter((_, idx) => idx !== i)
  update({ conditions })
}

function updateCondition(i: number, patch: Partial<AgentCondition>) {
  const conditions = props.modelValue.conditions.map((c, idx) =>
    idx === i ? { ...c, ...patch } : c
  )
  update({ conditions })
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
        <div v-if="ci > 0" class="and-row">
          <span class="and-badge">AND</span>
        </div>
        <div class="cond-row">
          <!-- Field -->
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

          <!-- Operator -->
          <select
            :value="c.op"
            class="input select cond-op"
            @change="updateCondition(ci, { op: ($event.target as HTMLSelectElement).value as ConditionOp, value: '' })"
          >
            <option value="=">= igual</option>
            <option value="$null">es nulo</option>
            <option value="$not_null">no es nulo</option>
          </select>

          <!-- Value (only for = operator) -->
          <template v-if="c.op === '='">
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
      <div class="trans-field">
        <span class="trans-label">En proceso</span>
        <select
          v-if="statusOptions?.length"
          :value="modelValue.onProcess"
          class="input select input-sm"
          @change="update({ onProcess: ($event.target as HTMLSelectElement).value })"
        >
          <option value="">— —</option>
          <option v-for="opt in statusOptions" :key="opt" :value="opt">{{ opt }}</option>
        </select>
        <input
          v-else
          :value="modelValue.onProcess"
          class="input input-sm"
          placeholder="refining"
          @input="update({ onProcess: ($event.target as HTMLInputElement).value })"
        />
      </div>
      <div class="trans-field">
        <span class="trans-label">Al terminar</span>
        <select
          v-if="statusOptions?.length"
          :value="modelValue.onFinish"
          class="input select input-sm"
          @change="update({ onFinish: ($event.target as HTMLSelectElement).value })"
        >
          <option value="">— —</option>
          <option v-for="opt in statusOptions" :key="opt" :value="opt">{{ opt }}</option>
        </select>
        <input
          v-else
          :value="modelValue.onFinish"
          class="input input-sm"
          placeholder="refined"
          @input="update({ onFinish: ($event.target as HTMLInputElement).value })"
        />
      </div>
      <div class="trans-field">
        <span class="trans-label">Al fallar</span>
        <select
          v-if="statusOptions?.length"
          :value="modelValue.onError"
          class="input select input-sm"
          @change="update({ onError: ($event.target as HTMLSelectElement).value })"
        >
          <option value="">— —</option>
          <option v-for="opt in statusOptions" :key="opt" :value="opt">{{ opt }}</option>
        </select>
        <input
          v-else
          :value="modelValue.onError"
          class="input input-sm"
          placeholder="queued"
          @input="update({ onError: ($event.target as HTMLInputElement).value })"
        />
      </div>
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
.and-row { display: flex; align-items: center; }
.and-badge {
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #7c3aed;
  background: #ede9fe;
  border: 1px solid #ddd6fe;
  border-radius: 4px;
  padding: 0.1rem 0.4rem;
  margin-left: 0.1rem;
}
.cond-row {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.cond-field { flex: 1 1 5rem; min-width: 0; }
.cond-op    { flex: 0 0 7.5rem; }
.cond-value { flex: 1 1 6rem; min-width: 0; }

/* ── Transitions ── */
.transitions {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 0.4rem 0.6rem;
  padding-top: 0.5rem;
  border-top: 1px solid #e9d5ff;
}
.trans-field { display: flex; flex-direction: column; gap: 0.15rem; }
.trans-label { font-size: 0.7rem; color: #6b7280; font-weight: 500; }

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
.input-sm { font-size: 0.78rem; padding: 0.3rem 0.5rem; }

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
</style>
