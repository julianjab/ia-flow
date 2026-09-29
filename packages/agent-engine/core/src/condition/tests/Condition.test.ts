import { describe, expect, it } from 'vitest'
import { Condition } from '../Condition.js'

describe('Condition.evaluate', () => {
  it('eq / neq', () => {
    expect(
      new Condition({ field: 'status', op: 'eq', value: 'open' }).evaluate({ status: 'open' }),
    ).toBe(true)
    expect(
      new Condition({ field: 'status', op: 'eq', value: 'open' }).evaluate({ status: 'closed' }),
    ).toBe(false)
    expect(
      new Condition({ field: 'status', op: 'neq', value: 'open' }).evaluate({ status: 'closed' }),
    ).toBe(true)
  })

  it('exists / notExists over nested paths', () => {
    expect(new Condition({ field: 'a.b', op: 'exists' }).evaluate({ a: { b: 1 } })).toBe(true)
    expect(new Condition({ field: 'a.b', op: 'exists' }).evaluate({ a: {} })).toBe(false)
    expect(new Condition({ field: 'a.b', op: 'exists' }).evaluate({ a: { b: null } })).toBe(false)
    expect(new Condition({ field: 'a.b', op: 'notExists' }).evaluate({ a: {} })).toBe(true)
    expect(new Condition({ field: 'missing.deep', op: 'notExists' }).evaluate({})).toBe(true)
  })

  it('in / notIn against a list', () => {
    const inCond = new Condition({ field: 'status', op: 'in', value: ['open', 'review'] })
    expect(inCond.evaluate({ status: 'open' })).toBe(true)
    expect(inCond.evaluate({ status: 'closed' })).toBe(false)
    expect(
      new Condition({ field: 'status', op: 'in', value: 'not-an-array' }).evaluate({
        status: 'open',
      }),
    ).toBe(false)

    const notInCond = new Condition({ field: 'status', op: 'notIn', value: ['closed'] })
    expect(notInCond.evaluate({ status: 'open' })).toBe(true)
    expect(notInCond.evaluate({ status: 'closed' })).toBe(false)
  })

  it('contains over arrays and strings', () => {
    expect(
      new Condition({ field: 'labels', op: 'contains', value: 'bug' }).evaluate({
        labels: ['bug', 'p1'],
      }),
    ).toBe(true)
    expect(
      new Condition({ field: 'title', op: 'contains', value: 'crash' }).evaluate({
        title: 'app crash',
      }),
    ).toBe(true)
    expect(
      new Condition({ field: 'title', op: 'contains', value: 'crash' }).evaluate({ title: 42 }),
    ).toBe(false)
  })

  it('notContains over arrays and strings, true when the field is absent', () => {
    const blocked = new Condition({ field: 'item.labels', op: 'notContains', value: 'blocked' })

    expect(blocked.evaluate({ item: { labels: ['e2e-test'] } })).toBe(true)
    expect(blocked.evaluate({ item: { labels: ['blocked'] } })).toBe(false)
    expect(blocked.evaluate({ item: {} })).toBe(true)
    expect(
      new Condition({ field: 's', op: 'notContains', value: 'x' }).evaluate({ s: 'abc' }),
    ).toBe(true)
  })

  it('matches tests a string field against a regex source', () => {
    const human = new Condition({
      field: 'body',
      op: 'matches',
      value: '^(?![\\s\\S]*<!-- ia-flow:)',
    })

    expect(human.evaluate({ body: 'pueden agregar paginación?' })).toBe(true)
    expect(human.evaluate({ body: 'reporte\n\n<!-- ia-flow:report -->' })).toBe(false)
    expect(human.evaluate({ body: 3 })).toBe(false)
  })

  it('matches rejects an invalid regex when built, not on every evaluate', () => {
    expect(() => new Condition({ field: 'body', op: 'matches', value: '(abc' })).toThrow(
      /body matches: regex inválida/,
    )
    const nonString = new Condition({ field: 'body', op: 'matches', value: 3 })
    expect(nonString.evaluate({ body: '3' })).toBe(false)
  })

  it('gt / gte / lt / lte are strict about numeric operands', () => {
    expect(new Condition({ field: 'n', op: 'gt', value: 5 }).evaluate({ n: 10 })).toBe(true)
    expect(new Condition({ field: 'n', op: 'gt', value: 5 }).evaluate({ n: 5 })).toBe(false)
    expect(new Condition({ field: 'n', op: 'gte', value: 5 }).evaluate({ n: 5 })).toBe(true)
    expect(new Condition({ field: 'n', op: 'lt', value: 5 }).evaluate({ n: 4 })).toBe(true)
    expect(new Condition({ field: 'n', op: 'lte', value: 5 }).evaluate({ n: 5 })).toBe(true)
    expect(new Condition({ field: 'n', op: 'gt', value: 5 }).evaluate({ n: 'not-a-number' })).toBe(
      false,
    )
    expect(new Condition({ field: 'n', op: 'gt', value: 'not-a-number' }).evaluate({ n: 10 })).toBe(
      false,
    )
  })

  it('an unknown op evaluates to false', () => {
    // @ts-expect-error — exercising the default branch on purpose.
    expect(new Condition({ field: 'n', op: 'bogus', value: 1 }).evaluate({ n: 1 })).toBe(false)
  })

  it('defaults logic to "and"', () => {
    expect(new Condition({ field: 'n', op: 'eq', value: 1 }).logic).toBe('and')
  })
})

describe('Condition.fromRows', () => {
  it('builds Condition instances from plain rows', () => {
    const conditions = Condition.fromRows([{ field: 'a', op: 'eq', value: 1 }])
    expect(conditions).toHaveLength(1)
    expect(conditions[0]).toBeInstanceOf(Condition)
  })

  it('returns an empty array for undefined', () => {
    expect(Condition.fromRows(undefined)).toEqual([])
  })
})

describe('Condition.evaluateAll', () => {
  it('an empty list always matches', () => {
    expect(Condition.evaluateAll([], {})).toBe(true)
  })

  it('chains with "and" by default', () => {
    const conditions = Condition.fromRows([
      { field: 'a', op: 'eq', value: 1 },
      { field: 'b', op: 'eq', value: 2 },
    ])
    expect(Condition.evaluateAll(conditions, { a: 1, b: 2 })).toBe(true)
    expect(Condition.evaluateAll(conditions, { a: 1, b: 3 })).toBe(false)
  })

  it('chains with "or" when a later entry sets logic: "or"', () => {
    const conditions = Condition.fromRows([
      { field: 'a', op: 'eq', value: 1 },
      { field: 'b', op: 'eq', value: 2, logic: 'or' },
    ])
    expect(Condition.evaluateAll(conditions, { a: 0, b: 2 })).toBe(true)
    expect(Condition.evaluateAll(conditions, { a: 0, b: 0 })).toBe(false)
  })
})

describe('Condition valueFrom', () => {
  it('compares against another field of the same payload', () => {
    const changed = new Condition({ field: 'to', op: 'neq', valueFrom: 'from' })

    expect(changed.evaluate({ from: 'Refine', to: 'Build' })).toBe(true)
    expect(changed.evaluate({ from: 'Build', to: 'Build' })).toBe(false)
    expect(
      new Condition({ field: 'n', op: 'in', valueFrom: 'list' }).evaluate({ n: 2, list: [1, 2] }),
    ).toBe(true)
  })

  it('survives toRow and says what it compared against', () => {
    const condition = new Condition({ field: 'to', op: 'neq', valueFrom: 'from' })

    expect(new Condition(condition.toRow()).evaluate({ from: 'a', to: 'a' })).toBe(false)
    expect(condition.describe({ from: 'a', to: 'a' })).toBe('to neq from ("a") (vino "a")')
  })

  it('is rejected on matches, whose pattern is fixed', () => {
    expect(() => new Condition({ field: 'body', op: 'matches', valueFrom: 'x' })).toThrow(
      /no admite valueFrom/,
    )
  })
})
