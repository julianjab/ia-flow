import { describe, expect, it } from 'bun:test'
import { condToOp, evalWhen } from '../when.js'

function task(fields: Record<string, unknown>): Record<string, unknown> {
  return fields
}

// ─── condToOp ────────────────────────────────────────────────────────────────

describe('condToOp', () => {
  it('passes through $null', () => expect(condToOp({ op: '$null' })).toBe('$null'))
  it('passes through $not_null', () => expect(condToOp({ op: '$not_null' })).toBe('$not_null'))
  it('encodes != with value', () => expect(condToOp({ op: '!=', value: 'foo' })).toBe('$ne:foo'))
  it('encodes != without value as $ne:', () => expect(condToOp({ op: '!=' })).toBe('$ne:'))
  it('returns value for = op', () => expect(condToOp({ op: '=', value: 'bar' })).toBe('bar'))
  it('returns empty string when = and no value', () => expect(condToOp({ op: '=' })).toBe(''))
})

// ─── evalWhen — legacy Record format (all-AND) ───────────────────────────────

describe('evalWhen — legacy Record format', () => {
  it('returns true when when is undefined', () => {
    expect(evalWhen(task({ type: 'functional' }), undefined)).toBe(true)
  })

  it('returns true when when is null', () => {
    expect(evalWhen(task({}), null)).toBe(true)
  })

  it('matches exact field equality', () => {
    expect(evalWhen(task({ type: 'functional' }), { type: 'functional' })).toBe(true)
    expect(evalWhen(task({ type: 'technical' }), { type: 'functional' })).toBe(false)
  })

  it('all conditions must match (AND semantics)', () => {
    const when = { type: 'functional', status: 'queued' }
    expect(evalWhen(task({ type: 'functional', status: 'queued' }), when)).toBe(true)
    expect(evalWhen(task({ type: 'functional', status: 'approved' }), when)).toBe(false)
  })

  it('$null matches missing/empty fields', () => {
    expect(evalWhen(task({}), { type: '$null' })).toBe(true)
    expect(evalWhen(task({ type: '' }), { type: '$null' })).toBe(true)
    expect(evalWhen(task({ type: 'functional' }), { type: '$null' })).toBe(false)
  })

  it('$not_null matches non-empty fields', () => {
    expect(evalWhen(task({ type: 'functional' }), { type: '$not_null' })).toBe(true)
    expect(evalWhen(task({}), { type: '$not_null' })).toBe(false)
  })

  it('$ne: matches not-equal', () => {
    expect(evalWhen(task({ type: 'technical' }), { type: '$ne:functional' })).toBe(true)
    expect(evalWhen(task({ type: 'functional' }), { type: '$ne:functional' })).toBe(false)
  })

  it('resolves field aliases (task type → type)', () => {
    expect(evalWhen(task({ type: 'functional' }), { 'task type': 'functional' })).toBe(true)
    expect(evalWhen(task({ type: 'functional' }), { task_type: 'functional' })).toBe(true)
  })

  it('resolves lowercase field name', () => {
    expect(evalWhen(task({ status: 'queued' }), { Status: 'queued' })).toBe(true)
  })

  it('arrays match by membership (for labels/assignees/repos)', () => {
    expect(evalWhen(task({ repos: ['a', 'b'] }), { repos: 'a' })).toBe(true)
    expect(evalWhen(task({ repos: ['a', 'b'] }), { repos: 'b' })).toBe(true)
    expect(evalWhen(task({ repos: ['a', 'b'] }), { repos: 'c' })).toBe(false)
    expect(evalWhen(task({ repos: [] }), { repos: '$null' })).toBe(true)
    expect(evalWhen(task({ repos: ['x'] }), { repos: '$not_null' })).toBe(true)
    expect(evalWhen(task({ repos: ['a', 'b'] }), { repos: '$ne:c' })).toBe(true)
    expect(evalWhen(task({ repos: ['a', 'b'] }), { repos: '$ne:a' })).toBe(false)
  })

  it('aliases GitHub Project built-in fields to Task keys', () => {
    // Repository → repos (array): matches when the value is in the array.
    expect(
      evalWhen(task({ repos: ['lh-seller-v2-frontend'] }), {
        Repository: 'lh-seller-v2-frontend',
      }),
    ).toBe(true)
    expect(
      evalWhen(task({ repos: ['ims-backend', 'lh-seller-v2-frontend'] }), {
        Repository: 'lh-seller-v2-frontend',
      }),
    ).toBe(true)
    expect(evalWhen(task({ repos: ['other-repo'] }), { Repository: 'ims-backend' })).toBe(false)
    expect(evalWhen(task({ labels: ['P0'] }), { Labels: 'P0' })).toBe(true)
    expect(evalWhen(task({ assignees: ['julianjab'] }), { Assignees: 'julianjab' })).toBe(true)
  })

  it('falls back to task.fields for source-native custom fields', () => {
    const t = task({ fields: { ImpProvider: 'API', Reviewed: 'yes' } })
    expect(evalWhen(t, { ImpProvider: 'API' })).toBe(true)
    expect(evalWhen(t, { ImpProvider: 'CLI' })).toBe(false)
    expect(evalWhen(t, { Reviewed: 'yes' })).toBe(true)
  })
})

// ─── evalWhen — new array format ─────────────────────────────────────────────

describe('evalWhen — new array format', () => {
  it('empty array always returns true', () => {
    expect(evalWhen(task({ type: 'functional' }), [])).toBe(true)
  })

  it('single condition equality', () => {
    const when = [{ field: 'type', op: '=', value: 'functional' }]
    expect(evalWhen(task({ type: 'functional' }), when)).toBe(true)
    expect(evalWhen(task({ type: 'technical' }), when)).toBe(false)
  })

  it('two AND conditions — both must match', () => {
    const when = [
      { field: 'type', op: '=', value: 'functional' },
      { field: 'status', op: '=', value: 'queued', logic: 'and' },
    ]
    expect(evalWhen(task({ type: 'functional', status: 'queued' }), when)).toBe(true)
    expect(evalWhen(task({ type: 'functional', status: 'approved' }), when)).toBe(false)
  })

  it('OR splits into groups — either group can match', () => {
    const when = [
      { field: 'type', op: '=', value: 'functional' },
      { field: 'type', op: '=', value: 'technical', logic: 'or' },
    ]
    expect(evalWhen(task({ type: 'functional' }), when)).toBe(true)
    expect(evalWhen(task({ type: 'technical' }), when)).toBe(true)
    expect(evalWhen(task({ type: 'other' }), when)).toBe(false)
  })

  it('AND has higher precedence than OR', () => {
    // (type=functional AND status=queued) OR (type=technical)
    const when = [
      { field: 'type', op: '=', value: 'functional' },
      { field: 'status', op: '=', value: 'queued', logic: 'and' },
      { field: 'type', op: '=', value: 'technical', logic: 'or' },
    ]
    expect(evalWhen(task({ type: 'functional', status: 'queued' }), when)).toBe(true)
    expect(evalWhen(task({ type: 'technical', status: 'anything' }), when)).toBe(true)
    // first group fails: type=functional but status≠queued; second group fails: type≠technical
    expect(evalWhen(task({ type: 'functional', status: 'approved' }), when)).toBe(false)
  })

  it('multiple OR groups — any matching group returns true', () => {
    const when = [
      { field: 'type', op: '=', value: 'a' },
      { field: 'type', op: '=', value: 'b', logic: 'or' },
      { field: 'type', op: '=', value: 'c', logic: 'or' },
    ]
    expect(evalWhen(task({ type: 'a' }), when)).toBe(true)
    expect(evalWhen(task({ type: 'b' }), when)).toBe(true)
    expect(evalWhen(task({ type: 'c' }), when)).toBe(true)
    expect(evalWhen(task({ type: 'd' }), when)).toBe(false)
  })

  it('supports != operator', () => {
    const when = [{ field: 'type', op: '!=', value: 'functional' }]
    expect(evalWhen(task({ type: 'technical' }), when)).toBe(true)
    expect(evalWhen(task({ type: 'functional' }), when)).toBe(false)
  })

  it('supports $null operator', () => {
    const when = [{ field: 'prd', op: '$null' }]
    expect(evalWhen(task({}), when)).toBe(true)
    expect(evalWhen(task({ prd: 'something' }), when)).toBe(false)
  })

  it('supports $not_null operator', () => {
    const when = [{ field: 'prd', op: '$not_null' }]
    expect(evalWhen(task({ prd: 'something' }), when)).toBe(true)
    expect(evalWhen(task({}), when)).toBe(false)
  })
})
