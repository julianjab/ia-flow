// Serialization helpers for the agent activation `when` DSL and the outcome
// `$set:` grammar. Moved out of AgentRunnerCard.vue (now
// removed — activation criteria live on the agent itself, not on a
// per-status entry) so WhenConditionsEditor / OutcomesEditor / AgentEditorModal
// can share the same conversion logic.

import {
  type AgentExit,
  type CommentTarget,
  ERROR_EXIT,
  SUCCESS_EXIT,
  exitComment,
  exitSet,
  exitWhen,
} from '@ia-flow/shared'
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
// como el usuario lo piensa y lo escribe. Ese mismo formato es el que viaja
// on-wire dentro del `$set:` del slot: `Labels` es el campo multi-valor del
// source y sus ops las resuelve el runtime contra el valor vigente (ver
// applyMultiValueOps en @ia-flow/issue-sources).
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
  // Una fila a medio llenar (campo elegido, valor todavía vacío) NO se emite:
  // `$set:Labels=` le pediría al source escribir el campo con valor vacío, que
  // no es lo que el usuario está diciendo — está a mitad de escribir, o acaba
  // de borrar el último token del campo. Vaciar un campo multi-valor a
  // propósito se expresa con el token `=` pelado, no con un valor ausente.
  const pairs = assignments.filter((a) => a.field.trim() && a.value.trim())
  if (!pairs.length) return ''
  return '$set:' + pairs.map((a) => `${a.field.trim()}=${a.value.trim()}`).join(',')
}

// Espejo exacto de `parseFieldAssignments` (packages/agent-engine/src/outcomes.ts):
// el separador de pares es `,` y el de campo/valor el PRIMER `=`, pero un token
// que no abre un par nuevo — sin `=`, o con el `=` en la posición 0, como el
// token `=reemplazar` del DSL multi-valor — no es un campo vacío: es la
// continuación del valor anterior. Eso es lo
// que permite que la fila `Labels` viaje con todas sus ops (`Labels=+a,-b`)
// dentro del mismo `$set:` en vez de necesitar un campo on-wire aparte. Si esta
// función y la del engine divergen, un outcome guardado desde la UI se aplica
// distinto de como se lee — mantenerlas iguales es parte del contrato.
export function deserializeAssignments(raw: string | undefined): FieldAssignment[] {
  if (!raw) return []
  if (!raw.startsWith('$set:')) return [{ field: 'status', value: raw }]

  const pairs: FieldAssignment[] = []
  for (const token of raw.slice(5).split(',')) {
    const eq = token.indexOf('=')
    if (eq <= 0) {
      const last = pairs[pairs.length - 1]
      const cont = token.trim()
      if (last && cont) last.value = last.value ? `${last.value},${cont}` : cont
      continue
    }
    const field = token.slice(0, eq).trim()
    const value = token.slice(eq + 1).trim()
    if (!field) continue
    const existing = pairs.find((p) => p.field.toLowerCase() === field.toLowerCase())
    if (existing) existing.value = existing.value ? `${existing.value},${value}` : value
    else pairs.push({ field, value })
  }
  return pairs
}

// ── Labels serialization ─────────────────────────────────────────────────────
// The grammar mirrors `$set:`: prefix + comma-separated tokens. Each token is
// `<prefix><label>` where prefix ∈ {`+`, `-`, `=`}. Empty labels are dropped.
// Order emitted: add (`+`), remove (`-`), replace (`=`). The runtime is free
// to interpret precedence — the serializer only guarantees a stable order so
// diffs on saved configs stay minimal.
// ── Outcomes form value ──────────────────────────────────────────────────────
// Una sola lista de asignaciones por slot, y un solo canal on-wire: el
// `$set:` del slot. Las labels no son una sección aparte ni un campo aparte —
// son la fila cuyo `field` es `Labels`, con los tokens con signo en su
// `value`, y viajan dentro del mismo string que el resto de los campos.
export interface OutcomesFormValue {
  onProcess: FieldAssignment[]
  /** Destino por defecto de los comentarios de ESTE agente. Vacío ⇒
   *  `pr-else-issue`: con un PR abierto comenta ahí, si no en el issue. Una
   *  salida puede pisarlo. */
  comment?: CommentTarget
  /** Salidas, en orden de edición. `success`/`error` son las dos reservadas
   *  (el engine elige entre ellas según cómo terminó el run) y van primero;
   *  el resto son las que el agente puede pedir por nombre. Es una lista y no
   *  un Record para que el orden de las filas del editor sea estable y el
   *  usuario pueda renombrar una salida sin que salte de lugar. */
  exits: ExitRow[]
}

export interface ExitRow {
  name: string
  assignments: FieldAssignment[]
  /** Cuándo usarla. Viaja al enum de `select_exit`, así que es lo que el
   *  modelo lee para decidir — no es una nota para humanos. Las reservadas no
   *  lo necesitan: las elige el engine, el agente nunca las pide. */
  when?: string
  /** Dónde comentar al tomar ESTA salida. Pisa el default del agente. A
   *  diferencia de `when`, las reservadas SÍ lo usan: `success` y `error` son
   *  dos hallazgos distintos y pueden pertenecer a lugares distintos. */
  comment?: CommentTarget
}

/** Por qué una fila de salida no se puede guardar. `null` = está bien. */
export type ExitRowError = 'duplicada' | 'reservada' | 'formato' | 'sin-nombre'

const EXIT_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Valida los nombres de las salidas.
 *
 * Las tres fallas que cubre terminaban en pérdida SILENCIOSA: `formToOutcomes`
 * arma un Record, así que dos filas con el mismo nombre colapsan en una y la
 * segunda se come a la primera sin que nadie avise. Lo mismo una fila llamada
 * `success`, que pisa la salida reservada que se edita más arriba.
 *
 * Devuelve un error por índice de fila para que el editor pinte la fila
 * culpable en vez de un cartel genérico.
 */
export function validateExits(exits: ExitRow[]): Array<ExitRowError | null> {
  const seen = new Map<string, number>()
  return exits.map((row, i) => {
    const name = row.name.trim()
    // Las reservadas son SIEMPRE las primeras y en su orden — las pone
    // `outcomesToForm`/`emptyOutcomesForm`, no el usuario. Distinguirlas por
    // posición y no por nombre es lo que permite marcar una fila que el
    // usuario llamó `success` sin marcar también a la `success` de verdad.
    if (i < RESERVED_EXITS.length && name === RESERVED_EXITS[i]) {
      seen.set(name, i)
      return null
    }
    // Una fila recién agregada nace sin nombre y no es un error todavía —
    // `formToOutcomes` la omite hasta que el usuario escriba algo.
    if (!name) return row.assignments.length ? 'sin-nombre' : null
    if (RESERVED_EXITS.includes(name as never)) return 'reservada'
    if (seen.has(name)) return 'duplicada'
    seen.set(name, i)
    if (!EXIT_NAME_RE.test(name)) return 'formato'
    return null
  })
}

/** Las dos que el engine elige solo: no se pueden borrar ni renombrar. */
export const RESERVED_EXITS = [SUCCESS_EXIT, ERROR_EXIT] as const

export function emptyOutcomesForm(): OutcomesFormValue {
  return {
    onProcess: [],
    exits: RESERVED_EXITS.map((name) => ({ name, assignments: [] })),
  }
}

// AgentOutcomes (raw on-wire strings) → OutcomesFormValue (editable form state)
export function outcomesToForm(outcomes: AgentOutcomes | undefined): OutcomesFormValue {
  const onProcess = deserializeAssignments(outcomes?.onProcess)
  const declared = outcomes?.exits ?? {}
  // Las reservadas siempre se muestran, aunque el agente no las declare: son
  // los dos caminos que el run puede tomar y dejarlas invisibles esconde que
  // ese agente no transiciona en uno de ellos.
  const names = [
    ...RESERVED_EXITS,
    ...Object.keys(declared).filter((n) => !RESERVED_EXITS.includes(n as never)),
  ]
  return {
    onProcess,
    comment: outcomes?.comment,
    exits: names.map((name) => ({
      name,
      assignments: deserializeAssignments(exitSet(declared[name])),
      when: exitWhen(declared[name]),
      comment: exitComment(declared[name]),
    })),
  }
}

// OutcomesFormValue → AgentOutcomes, omitting empty slots (mirrors how the
// rest of AgentDefinition omits blank optional fields on save).
export function formToOutcomes(form: OutcomesFormValue): AgentOutcomes {
  const outcomes: AgentOutcomes = {}
  // Varias filas `Labels` en una misma salida se emiten como claves repetidas
  // (`Labels=+a,Labels=-b`) en vez de que una pise a la otra: el parser —
  // acá y en el engine — las acumula, así que el usuario no pierde tokens
  // por agregar dos filas.
  const onProcess = serializeAssignments(form.onProcess)
  if (onProcess) outcomes.onProcess = onProcess
  const exits: Record<string, AgentExit> = {}
  const problems = validateExits(form.exits)
  for (const [i, row] of form.exits.entries()) {
    // Una fila inválida NO se emite: mejor que el usuario vea la fila marcada
    // en rojo y sin guardar, a que se guarde pisando otra en silencio.
    if (problems[i]) continue
    const name = row.name.trim()
    if (!name) continue
    const serialized = serializeAssignments(row.assignments)
    if (!serialized) continue
    const when = row.when?.trim()
    // La forma corta (string pelado) se conserva cuando no hay nada más que
    // decir: es la que usa el 90% del roster y ensuciarla con un objeto de una
    // sola clave haría ruido en todos los diffs de config.
    exits[name] =
      when || row.comment
        ? {
            set: serialized,
            ...(when ? { when } : {}),
            ...(row.comment ? { comment: row.comment } : {}),
          }
        : serialized
  }
  if (Object.keys(exits).length) outcomes.exits = exits
  if (form.comment) outcomes.comment = form.comment
  return outcomes
}
