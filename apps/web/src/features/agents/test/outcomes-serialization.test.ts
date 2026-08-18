import { describe, expect, it } from 'vitest'
import {
  deserializeLabels,
  emptyLabelOps,
  emptyOutcomesForm,
  entryToWhen,
  formToOutcomes,
  normalizeWhen,
  outcomesToForm,
  serializeAssignments,
  serializeLabels,
  whenToConditions,
} from '../outcomes-serialization'

describe('serializeLabels', () => {
  it('returns empty string for empty ops', () => {
    expect(serializeLabels(emptyLabelOps())).toBe('')
  })

  it('emits + prefix for add labels', () => {
    expect(serializeLabels({ add: ['a', 'b'], remove: [], replace: [] })).toBe('$labels:+a,+b')
  })

  it('emits - prefix for remove labels', () => {
    expect(serializeLabels({ add: [], remove: ['stale'], replace: [] })).toBe('$labels:-stale')
  })

  it('emits = prefix for replace labels', () => {
    expect(serializeLabels({ add: [], remove: [], replace: ['bug'] })).toBe('$labels:=bug')
  })

  it('combines all three action lists in add-remove-replace order', () => {
    const raw = serializeLabels({
      add: ['ci-checked', 'needs-review'],
      remove: ['stale'],
      replace: ['bug'],
    })
    expect(raw).toBe('$labels:+ci-checked,+needs-review,-stale,=bug')
  })

  it('trims whitespace and drops empty labels', () => {
    expect(serializeLabels({ add: ['  spaced  ', ''], remove: ['  '], replace: ['x'] })).toBe(
      '$labels:+spaced,=x',
    )
  })
})

describe('deserializeLabels', () => {
  it('returns empty ops for undefined', () => {
    expect(deserializeLabels(undefined)).toEqual(emptyLabelOps())
  })

  it('returns empty ops for empty string', () => {
    expect(deserializeLabels('')).toEqual(emptyLabelOps())
  })

  it('returns empty ops for non-$labels: strings (safe fallback)', () => {
    // $set: strings belong to a different column and MUST NOT leak in as
    // chips — otherwise the modal would double-serialize them on save.
    expect(deserializeLabels('$set:status=Done')).toEqual(emptyLabelOps())
    expect(deserializeLabels('Done')).toEqual(emptyLabelOps())
  })

  it('parses +/-/= tokens into the matching action list', () => {
    const ops = deserializeLabels('$labels:+ci-checked,+needs-review,-stale,=bug')
    expect(ops.add).toEqual(['ci-checked', 'needs-review'])
    expect(ops.remove).toEqual(['stale'])
    expect(ops.replace).toEqual(['bug'])
  })

  it('ignores unknown prefixes without throwing', () => {
    const ops = deserializeLabels('$labels:+ok,!huh,*nope,-drop')
    expect(ops.add).toEqual(['ok'])
    expect(ops.remove).toEqual(['drop'])
    expect(ops.replace).toEqual([])
  })

  it('ignores tokens with empty label body', () => {
    expect(deserializeLabels('$labels:+,-,+real')).toEqual({
      add: ['real'],
      remove: [],
      replace: [],
    })
  })
})

describe('label round-trip', () => {
  it('serialize → deserialize → serialize is stable', () => {
    const ops = { add: ['ci-checked', 'needs-review'], remove: ['stale'], replace: [] }
    const raw = serializeLabels(ops)
    const parsed = deserializeLabels(raw)
    expect(parsed).toEqual(ops)
    expect(serializeLabels(parsed)).toBe(raw)
  })

  it('deserialize → serialize is stable for the PRD example', () => {
    for (const raw of ['$labels:+ci-checked,+needs-review,-stale', '$labels:=bug']) {
      expect(serializeLabels(deserializeLabels(raw))).toBe(raw)
    }
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
  it('outcomesToForm hydrates all six slots from raw AgentOutcomes', () => {
    const form = outcomesToForm({
      onProcess: '$set:status=In Progress',
      onFinishLabels: '$labels:+done',
    })
    expect(form.onProcess).toEqual([{ field: 'status', value: 'In Progress' }])
    expect(form.onFinishLabels.add).toEqual(['done'])
    expect(form.onError).toEqual([])
  })

  it('formToOutcomes omits empty slots', () => {
    const form = emptyOutcomesForm()
    form.onProcess = [{ field: 'status', value: 'In Progress' }]
    const outcomes = formToOutcomes(form)
    expect(outcomes).toEqual({ onProcess: '$set:status=In Progress' })
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
