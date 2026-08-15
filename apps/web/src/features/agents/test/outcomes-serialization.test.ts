import { describe, expect, it } from 'vitest'
import {
  LABELS_FIELD,
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

describe('outcomes form conversion', () => {
  it('las labels entran como una fila de campo más, al final del slot', () => {
    const form = outcomesToForm({
      onFinish: '$set:status=Done',
      onFinishLabels: '$labels:+ci-checked,-stale',
    })
    expect(form.onFinish).toEqual([
      { field: 'status', value: 'Done' },
      { field: LABELS_FIELD, value: '+ci-checked,-stale' },
    ])
  })

  it('formToOutcomes separa la fila de labels de los $set:', () => {
    const form = emptyOutcomesForm()
    form.onFinish = [
      { field: 'status', value: 'Done' },
      { field: LABELS_FIELD, value: '+ci-checked,-stale' },
    ]
    expect(formToOutcomes(form)).toEqual({
      onFinish: '$set:status=Done',
      onFinishLabels: '$labels:+ci-checked,-stale',
    })
  })

  it('varias filas Labels en un slot se concatenan en vez de pisarse', () => {
    const form = emptyOutcomesForm()
    form.onFinish = [
      { field: LABELS_FIELD, value: '+a' },
      { field: LABELS_FIELD, value: '-b' },
    ]
    expect(formToOutcomes(form).onFinishLabels).toBe('$labels:+a,-b')
  })

  it('formToOutcomes omite los slots vacíos', () => {
    const form = emptyOutcomesForm()
    form.onProcess = [{ field: 'status', value: 'In Progress' }]
    expect(formToOutcomes(form)).toEqual({ onProcess: '$set:status=In Progress' })
  })

  it('formToOutcomes → outcomesToForm round-trips', () => {
    const outcomes = { onProcess: '$set:status=Done', onErrorLabels: '$labels:-flaky' }
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
