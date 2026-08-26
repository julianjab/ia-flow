import { describe, expect, it } from 'vitest'
import {
  type FieldAssignment,
  LABELS_FIELD,
  type OutcomesFormValue,
  emptyOutcomesForm,
  entryToWhen,
  formToOutcomes,
  isLabelsField,
  normalizeWhen,
  outcomesToForm,
  parseLabelTokens,
  serializeAssignments,
  serializeLabelTokens,
  whenToConditions,
} from '../outcomes-serialization'

describe('parseLabelTokens / serializeLabelTokens', () => {
  it('lee el signo pegado a cada label', () => {
    expect(parseLabelTokens('+design,-wip')).toEqual([
      { sign: '+', label: 'design' },
      { sign: '-', label: 'wip' },
    ])
  })

  it('un token sin signo se asume añadir', () => {
    // Es el typo más probable y "añadir" es la lectura que no destruye nada.
    expect(parseLabelTokens('design')).toEqual([{ sign: '+', label: 'design' }])
  })

  it('soporta reemplazar (=) para no dejar configs viejas sin editar', () => {
    expect(parseLabelTokens('=bug')).toEqual([{ sign: '=', label: 'bug' }])
  })

  it('ignora tokens vacíos y espacios sobrantes', () => {
    expect(parseLabelTokens(' +a , , -b ,')).toEqual([
      { sign: '+', label: 'a' },
      { sign: '-', label: 'b' },
    ])
  })

  it('round-trip estable', () => {
    for (const raw of ['+ci-checked,+needs-review,-stale', '=bug', '-flaky']) {
      expect(serializeLabelTokens(parseLabelTokens(raw))).toBe(raw)
    }
  })
})

describe('isLabelsField', () => {
  it('matchea el pseudo-campo sin importar mayúsculas', () => {
    expect(isLabelsField('Labels')).toBe(true)
    expect(isLabelsField('labels')).toBe(true)
    expect(isLabelsField(' LABELS ')).toBe(true)
    expect(isLabelsField('status')).toBe(false)
  })
})

describe('whenToConditions / entryToWhen', () => {
  it('converts legacy record format to all-AND conditions', () => {
    const conditions = whenToConditions({ status: 'Refined', priority: '$ne:low' })
    expect(conditions).toEqual([
      { field: 'status', op: '=', value: 'Refined', logic: 'and' },
      { field: 'priority', op: '!=', value: 'low', logic: 'and' },
    ])
  })

  it('converts $null / $not_null sentinels', () => {
    const conditions = whenToConditions({ assignee: '$null' })
    expect(conditions).toEqual([{ field: 'assignee', op: '$null', value: '', logic: 'and' }])
  })

  it('round-trips the array format through entryToWhen', () => {
    const when = [
      { field: 'status', op: '=', value: 'Refined' },
      { field: 'priority', op: '!=', value: 'low', logic: 'or' as const },
    ]
    const conditions = whenToConditions(when)
    expect(entryToWhen(conditions)).toEqual(when)
  })

  it('drops conditions with an empty field', () => {
    const conditions = [{ field: '  ', op: '=' as const, value: 'x', logic: 'and' as const }]
    expect(entryToWhen(conditions)).toEqual([])
  })

  it('normalizeWhen is idempotent across legacy and array formats', () => {
    const legacy = normalizeWhen({ status: 'Refined' })
    expect(normalizeWhen(legacy)).toEqual(legacy)
  })
})

// La forma del editor pasó de tres slots fijos a `onProcess` + una lista de
// salidas con nombre. Estos dos helpers leen/escriben una salida por su nombre
// para que cada test siga hablando del caso que le importa y no de índices.
function exitRow(form: OutcomesFormValue, name: string) {
  return form.exits.find((e) => e.name === name)?.assignments
}
function withExit(name: string, assignments: FieldAssignment[]): OutcomesFormValue {
  const form = emptyOutcomesForm()
  const row = form.exits.find((e) => e.name === name)
  if (row) row.assignments = assignments
  else form.exits.push({ name, assignments })
  return form
}

describe('outcomes form conversion', () => {
  it('las labels entran como una fila de campo más, dentro del mismo $set:', () => {
    const form = outcomesToForm({
      exits: { success: '$set:status=Done,Labels=+ci-checked,-stale' },
    })
    expect(exitRow(form, 'success')).toEqual([
      { field: 'status', value: 'Done' },
      { field: LABELS_FIELD, value: '+ci-checked,-stale' },
    ])
  })

  it('formToOutcomes emite la fila de labels en el mismo $set: que el resto', () => {
    const form = withExit('success', [
      { field: 'status', value: 'Done' },
      { field: LABELS_FIELD, value: '+ci-checked,-stale' },
    ])
    expect(formToOutcomes(form)).toEqual({
      exits: { success: '$set:status=Done,Labels=+ci-checked,-stale' },
    })
  })

  it('varias filas Labels en una salida se acumulan en vez de pisarse', () => {
    // Se emiten como clave repetida; el parser (acá y en el engine) las junta.
    const form = withExit('success', [
      { field: LABELS_FIELD, value: '+a' },
      { field: LABELS_FIELD, value: '-b' },
    ])
    const outcomes = formToOutcomes(form)
    expect(outcomes.exits?.success).toBe('$set:Labels=+a,Labels=-b')
    expect(exitRow(outcomesToForm(outcomes), 'success')).toEqual([
      { field: LABELS_FIELD, value: '+a,-b' },
    ])
  })

  it('un token = sobrevive el round-trip (reemplazo mezclado con +/-)', () => {
    // Espejo del parser del engine: sin esto la UI borraba el reemplazo al
    // reabrir y volver a guardar el agente.
    const outcomes = { exits: { success: '$set:Labels=+a,-b,=c' } }
    expect(exitRow(outcomesToForm(outcomes), 'success')).toEqual([
      { field: LABELS_FIELD, value: '+a,-b,=c' },
    ])
    expect(formToOutcomes(outcomesToForm(outcomes))).toEqual(outcomes)
  })

  it('un status pelado se hidrata como la fila status', () => {
    // Forma corta legacy: el runtime la sigue aceptando como
    // `$set:status=<nombre>`, así que el editor tiene que poder abrirla.
    expect(exitRow(outcomesToForm({ exits: { success: 'In Review' } }), 'success')).toEqual([
      { field: 'status', value: 'In Review' },
    ])
  })

  it('formToOutcomes omite las salidas vacías', () => {
    const form = emptyOutcomesForm()
    form.onProcess = [{ field: 'status', value: 'In Progress' }]
    // `success`/`error` se muestran siempre en el editor, pero sin campos no
    // se serializan: un agente sin transición declarada tiene que seguir sin
    // transición, no con una vacía.
    expect(formToOutcomes(form)).toEqual({ onProcess: '$set:status=In Progress' })
  })

  it('una salida con nombre propio sobrevive el round-trip', () => {
    // Es la que el agente puede pedir con `select_exit`.
    const outcomes = {
      exits: { success: '$set:status=Done', 'back-to-build': '$set:Labels=+agent:build' },
    }
    expect(formToOutcomes(outcomesToForm(outcomes))).toEqual(outcomes)
  })

  it('formToOutcomes → outcomesToForm round-trips', () => {
    const outcomes = { onProcess: '$set:status=Done', exits: { error: '$set:Labels=-flaky' } }
    expect(formToOutcomes(outcomesToForm(outcomes))).toEqual(outcomes)
  })
})

describe('serializeAssignments', () => {
  it('returns empty string for no assignments', () => {
    expect(serializeAssignments([])).toBe('')
  })

  it('joins field=value pairs with $set: prefix', () => {
    expect(serializeAssignments([{ field: 'status', value: 'Done' }])).toBe('$set:status=Done')
  })
})
