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
// Las labels son un campo más de la lista de outcomes: una fila cuyo `field`
// es `Labels` y cuyo `value` son tokens con signo (`+design,-wip`). El signo
// viaja pegado a cada label — no hay listas separadas por acción — porque es
// como el usuario lo piensa y lo escribe, y es exactamente el formato que ya
// viaja en el string `$labels:`.
export type LabelSign = '+' | '-' | '='
export interface LabelToken {
  sign: LabelSign
  label: string
}

/** Nombre del pseudo-campo que representa las labels dentro de los outcomes. */
export const LABELS_FIELD = 'Labels'

export function isLabelsField(field: string): boolean {
  return field.trim().toLowerCase() === LABELS_FIELD.toLowerCase()
}

/** `"+design,-wip"` → tokens. Un token sin signo se asume `+` (añadir). */
export function parseLabelTokens(value: string | undefined): LabelToken[] {
  if (!value) return []
  const out: LabelToken[] = []
  for (const raw of value.split(',')) {
    const t = raw.trim()
    if (!t) continue
    const sign = t[0]
    if (sign === '+' || sign === '-' || sign === '=') {
      const label = t.slice(1).trim()
      if (label) out.push({ sign, label })
    } else {
      out.push({ sign: '+', label: t })
    }
  }
  return out
}

export function serializeLabelTokens(tokens: LabelToken[]): string {
  return tokens
    .filter((t) => t.label.trim())
    .map((t) => `${t.sign}${t.label.trim()}`)
    .join(',')
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
const LABEL_PREFIX = '$labels:'

// ── Outcomes form value ──────────────────────────────────────────────────────
// Una sola lista de asignaciones por slot. Las labels no son una sección
// aparte: son la fila cuyo `field` es `Labels`, con los tokens con signo en su
// `value`. En el on-wire siguen viajando en su propio campo (`onXLabels`),
// porque el runtime las aplica con una primitiva distinta (`setLabels`) que
// los `$set:` de campos.
export interface OutcomesFormValue {
  onProcess: FieldAssignment[]
  onFinish: FieldAssignment[]
  onError: FieldAssignment[]
}

export function emptyOutcomesForm(): OutcomesFormValue {
  return { onProcess: [], onFinish: [], onError: [] }
}

const SLOTS = [
  { key: 'onProcess', labelsKey: 'onProcessLabels' },
  { key: 'onFinish', labelsKey: 'onFinishLabels' },
  { key: 'onError', labelsKey: 'onErrorLabels' },
] as const

// AgentOutcomes (raw on-wire strings) → OutcomesFormValue (editable form state)
export function outcomesToForm(outcomes: AgentOutcomes | undefined): OutcomesFormValue {
  const form = emptyOutcomesForm()
  for (const { key, labelsKey } of SLOTS) {
    const rows = deserializeAssignments(outcomes?.[key])
    const labels = outcomes?.[labelsKey]
    // La fila de labels va al final: se agrega después de los campos, que es
    // el orden en que se leen ("qué campos toco, y qué labels").
    if (labels?.startsWith(LABEL_PREFIX)) {
      const body = labels.slice(LABEL_PREFIX.length).trim()
      if (body) rows.push({ field: LABELS_FIELD, value: body })
    }
    form[key] = rows
  }
  return form
}

// OutcomesFormValue → AgentOutcomes, omitting empty slots (mirrors how the
// rest of AgentDefinition omits blank optional fields on save).
export function formToOutcomes(form: OutcomesFormValue): AgentOutcomes {
  const outcomes: AgentOutcomes = {}
  for (const { key, labelsKey } of SLOTS) {
    const rows = form[key]
    const fields = serializeAssignments(rows.filter((r) => !isLabelsField(r.field)))
    if (fields) outcomes[key] = fields
    // Varias filas `Labels` en un mismo slot se concatenan en vez de que una
    // pise a la otra — el usuario no debería perder tokens por agregar dos.
    const tokens = rows
      .filter((r) => isLabelsField(r.field))
      .flatMap((r) => parseLabelTokens(r.value))
    const labels = serializeLabelTokens(tokens)
    if (labels) outcomes[labelsKey] = LABEL_PREFIX + labels
  }
  return outcomes
}
