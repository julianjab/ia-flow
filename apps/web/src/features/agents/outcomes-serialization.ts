// Serialization helpers for the agent activation `when` DSL and the outcome
// `$set:` / `$labels:` grammars. Moved out of AgentRunnerCard.vue (now
// removed — activation criteria live on the agent itself, not on a
// per-status entry) so WhenConditionsEditor / OutcomesEditor / AgentEditorModal
// can share the same conversion logic.

import type { AgentOutcomes, WhenCondition } from '@ia-flow/shared'

export type ConditionOp = '=' | '!=' | '$null' | '$not_null'
// logic: conector con la condición ANTERIOR (undefined / 'and' en la primera)
export interface AgentCondition {
  field: string
  op: ConditionOp
  value: string
  logic: 'and' | 'or'
}
export interface FieldAssignment {
  field: string
  value: string
}

// ── Labels ───────────────────────────────────────────────────────────────────
// Per-outcome bag of label operations. Each action holds its own list of
// free-text chips so the UI can render three rows (Añadir / Quitar /
// Reemplazar por) without collapsing them into a discriminated union — the
// on-wire string carries the disambiguation via the `+ - =` prefixes.
export type LabelAction = 'add' | 'remove' | 'replace'
export interface LabelOperation {
  action: LabelAction
  labels: string[]
}
export interface LabelOps {
  add: string[]
  remove: string[]
  replace: string[]
}

export interface ProjectField {
  name: string
  dataType: string
  options: string[]
}

// AgentCondition[] → WhenCondition[] (new array format)
export function entryToWhen(conditions: AgentCondition[]): WhenCondition[] {
  return conditions
    .filter((c) => c.field.trim())
    .map((c, i) => {
      const entry: WhenCondition = { field: c.field.trim(), op: c.op }
      if (c.op === '=' || c.op === '!=') entry.value = c.value.trim()
      if (i > 0) entry.logic = c.logic
      return entry
    })
}

// WhenCondition[] | Record<string,string> | undefined → AgentCondition[]
export function whenToConditions(
  when: WhenCondition[] | Record<string, string> | undefined,
): AgentCondition[] {
  if (!when) return []

  // legacy Record format → all-AND
  if (!Array.isArray(when)) {
    return Object.entries(when).map(([field, raw]) => {
      if (raw === '$null')
        return { field, op: '$null' as ConditionOp, value: '', logic: 'and' as const }
      if (raw === '$not_null')
        return { field, op: '$not_null' as ConditionOp, value: '', logic: 'and' as const }
      if (raw.startsWith('$ne:'))
        return { field, op: '!=' as ConditionOp, value: raw.slice(4), logic: 'and' as const }
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

// Round-trip helper: whatever shape `when` arrives in (array or legacy
// record), normalize it to the current WhenCondition[] wire format.
export function normalizeWhen(
  when: WhenCondition[] | Record<string, string> | undefined,
): WhenCondition[] {
  return entryToWhen(whenToConditions(when))
}

// "$set:field1=val1,field2=val2" ↔ FieldAssignment[]
export function serializeAssignments(assignments: FieldAssignment[]): string {
  const pairs = assignments.filter((a) => a.field.trim())
  if (!pairs.length) return ''
  return '$set:' + pairs.map((a) => `${a.field.trim()}=${a.value.trim()}`).join(',')
}

export function deserializeAssignments(raw: string | undefined): FieldAssignment[] {
  if (!raw) return []
  if (raw.startsWith('$set:')) {
    return raw
      .slice(5)
      .split(',')
      .map((pair) => {
        const eq = pair.indexOf('=')
        return eq >= 0
          ? { field: pair.slice(0, eq), value: pair.slice(eq + 1) }
          : { field: pair, value: '' }
      })
      .filter((a) => a.field)
  }
  return [{ field: 'status', value: raw }]
}

// ── Labels serialization ─────────────────────────────────────────────────────
// The grammar mirrors `$set:`: prefix + comma-separated tokens. Each token is
// `<prefix><label>` where prefix ∈ {`+`, `-`, `=`}. Empty labels are dropped.
// Order emitted: add (`+`), remove (`-`), replace (`=`). The runtime is free
// to interpret precedence — the serializer only guarantees a stable order so
// diffs on saved configs stay minimal.
export function emptyLabelOps(): LabelOps {
  return { add: [], remove: [], replace: [] }
}

const LABEL_PREFIX = '$labels:'

export function serializeLabels(ops: LabelOps): string {
  const add = ops.add
    .map((s) => s.trim())
    .filter(Boolean)
    .map((l) => `+${l}`)
  const remove = ops.remove
    .map((s) => s.trim())
    .filter(Boolean)
    .map((l) => `-${l}`)
  const replace = ops.replace
    .map((s) => s.trim())
    .filter(Boolean)
    .map((l) => `=${l}`)
  const tokens = [...add, ...remove, ...replace]
  if (!tokens.length) return ''
  return LABEL_PREFIX + tokens.join(',')
}

export function deserializeLabels(raw: string | undefined): LabelOps {
  const ops = emptyLabelOps()
  if (!raw || !raw.startsWith(LABEL_PREFIX)) return ops
  const body = raw.slice(LABEL_PREFIX.length)
  if (!body) return ops
  for (const token of body.split(',')) {
    const t = token.trim()
    if (!t) continue
    const prefix = t[0]
    const label = t.slice(1).trim()
    if (!label) continue
    if (prefix === '+') ops.add.push(label)
    else if (prefix === '-') ops.remove.push(label)
    else if (prefix === '=') ops.replace.push(label)
    // Unknown prefix → ignore. Round-tripping via serializeLabels will drop it.
  }
  return ops
}

// ── Outcomes form value ──────────────────────────────────────────────────────
// The editable, deserialized shape OutcomesEditor works with — one
// FieldAssignment[] + LabelOps pair per transition slot.
export interface OutcomesFormValue {
  onProcess: FieldAssignment[]
  onFinish: FieldAssignment[]
  onError: FieldAssignment[]
  onProcessLabels: LabelOps
  onFinishLabels: LabelOps
  onErrorLabels: LabelOps
}

export function emptyOutcomesForm(): OutcomesFormValue {
  return {
    onProcess: [],
    onFinish: [],
    onError: [],
    onProcessLabels: emptyLabelOps(),
    onFinishLabels: emptyLabelOps(),
    onErrorLabels: emptyLabelOps(),
  }
}

// AgentOutcomes (raw on-wire strings) → OutcomesFormValue (editable form state)
export function outcomesToForm(outcomes: AgentOutcomes | undefined): OutcomesFormValue {
  return {
    onProcess: deserializeAssignments(outcomes?.onProcess),
    onFinish: deserializeAssignments(outcomes?.onFinish),
    onError: deserializeAssignments(outcomes?.onError),
    onProcessLabels: deserializeLabels(outcomes?.onProcessLabels),
    onFinishLabels: deserializeLabels(outcomes?.onFinishLabels),
    onErrorLabels: deserializeLabels(outcomes?.onErrorLabels),
  }
}

// OutcomesFormValue → AgentOutcomes, omitting empty slots (mirrors how the
// rest of AgentDefinition omits blank optional fields on save).
export function formToOutcomes(form: OutcomesFormValue): AgentOutcomes {
  const outcomes: AgentOutcomes = {}
  const onProcess = serializeAssignments(form.onProcess)
  const onFinish = serializeAssignments(form.onFinish)
  const onError = serializeAssignments(form.onError)
  if (onProcess) outcomes.onProcess = onProcess
  if (onFinish) outcomes.onFinish = onFinish
  if (onError) outcomes.onError = onError
  const onProcessLabels = serializeLabels(form.onProcessLabels)
  const onFinishLabels = serializeLabels(form.onFinishLabels)
  const onErrorLabels = serializeLabels(form.onErrorLabels)
  if (onProcessLabels) outcomes.onProcessLabels = onProcessLabels
  if (onFinishLabels) outcomes.onFinishLabels = onFinishLabels
  if (onErrorLabels) outcomes.onErrorLabels = onErrorLabels
  return outcomes
}
