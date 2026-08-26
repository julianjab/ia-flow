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
  validateExits,
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

describe('validación de nombres de salida', () => {
  // Las tres fallas terminaban en pérdida SILENCIOSA: `formToOutcomes` arma un
  // Record, así que dos filas con el mismo nombre colapsaban en una.
  function rows(...names: string[]) {
    const f = emptyOutcomesForm()
    for (const name of names) {
      f.exits.push({ name, assignments: [{ field: 'status', value: 'X' }] })
    }
    return f
  }

  it('un nombre repetido marca la SEGUNDA fila y no se guarda', () => {
    const f = rows('back-to-build', 'back-to-build')
    expect(validateExits(f.exits)).toEqual([null, null, null, 'duplicada'])
    // La primera sobrevive entera; la segunda no pisa nada.
    expect(formToOutcomes(f).exits).toEqual({ 'back-to-build': '$set:status=X' })
  })

  it('un nombre que choca con una reservada se rechaza en vez de pisarla', () => {
    const f = emptyOutcomesForm()
    f.exits[0].assignments = [{ field: 'status', value: 'Done' }]
    f.exits.push({ name: 'success', assignments: [{ field: 'status', value: 'Pisado' }] })
    expect(validateExits(f.exits)[2]).toBe('reservada')
    expect(formToOutcomes(f).exits).toEqual({ success: '$set:status=Done' })
  })

  it('exige kebab-case: el nombre viaja al enum que el agente nombra', () => {
    expect(validateExits(rows('back to build').exits)[2]).toBe('formato')
    expect(validateExits(rows('BackToBuild').exits)[2]).toBe('formato')
    expect(validateExits(rows('back-to-build-2').exits)[2]).toBeNull()
  })

  it('una fila recién agregada no es un error hasta que tenga campos', () => {
    const f = emptyOutcomesForm()
    f.exits.push({ name: '', assignments: [] })
    expect(validateExits(f.exits)[2]).toBeNull()
    f.exits[2].assignments = [{ field: 'status', value: 'X' }]
    expect(validateExits(f.exits)[2]).toBe('sin-nombre')
  })
})

describe('el "cuándo usarla" de una salida', () => {
  it('se guarda en la forma larga y sobrevive el round-trip', () => {
    const f = emptyOutcomesForm()
    f.exits.push({
      name: 'back-to-build',
      assignments: [{ field: 'status', value: 'Build' }],
      when: 'El PRD está bien y falla la implementación.',
    })
    const out = formToOutcomes(f)
    expect(out.exits?.['back-to-build']).toEqual({
      set: '$set:status=Build',
      when: 'El PRD está bien y falla la implementación.',
    })
    expect(formToOutcomes(outcomesToForm(out))).toEqual(out)
  })

  it('sin "cuándo", la salida se guarda en la forma corta', () => {
    // No inventamos un objeto con `when: undefined` — `success`/`error` nunca
    // lo necesitan y ensuciaría el YAML de todos los rosters.
    const f = emptyOutcomesForm()
    f.exits.push({ name: 'back-to-build', assignments: [{ field: 'status', value: 'Build' }] })
    expect(formToOutcomes(f).exits?.['back-to-build']).toBe('$set:status=Build')
  })
})
