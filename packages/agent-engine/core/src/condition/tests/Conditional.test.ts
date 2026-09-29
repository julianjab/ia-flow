import { describe, expect, it } from 'vitest'
import { Condition } from '../Condition.js'
import { Conditional } from '../Conditional.js'

class TestConditional extends Conditional {}

describe('Conditional', () => {
  it('defaults `when` to an empty array', () => {
    const conditional = new TestConditional({})
    expect(conditional.when).toEqual([])
  })

  it('matchesConditions delegates to Condition.evaluateAll — empty `when` always matches', () => {
    const conditional = new TestConditional({})
    expect(conditional.matchesConditions({ anything: true })).toBe(true)
  })

  it('matchesConditions evaluates a single condition against the subject', () => {
    const conditional = new TestConditional({
      when: Condition.fromRows([{ field: 'status', op: 'eq', value: 'open' }]),
    })
    expect(conditional.matchesConditions({ status: 'open' })).toBe(true)
    expect(conditional.matchesConditions({ status: 'closed' })).toBe(false)
  })

  it('matchesConditions chains multiple conditions with and/or, same as Condition.evaluateAll', () => {
    const conditional = new TestConditional({
      when: Condition.fromRows([
        { field: 'a', op: 'eq', value: 1 },
        { field: 'b', op: 'eq', value: 2, logic: 'or' },
      ]),
    })
    expect(conditional.matchesConditions({ a: 0, b: 2 })).toBe(true)
    expect(conditional.matchesConditions({ a: 0, b: 0 })).toBe(false)
  })
})
