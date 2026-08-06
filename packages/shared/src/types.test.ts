import { describe, expect, it } from 'bun:test'
import { WhenConditionSchema, StatusAgentEntrySchema } from './schemas.js'
import type { WhenCondition, StatusAgentEntry } from './types.js'

// types.ts re-exports inferred types from schemas — verify the inferred shapes
// match expected structural contracts so any accidental schema change is caught.

describe('WhenCondition type', () => {
  it('inferred type satisfies WhenCondition interface', () => {
    const cond: WhenCondition = WhenConditionSchema.parse({
      field: 'type',
      op: '=',
      value: 'functional',
      logic: 'and',
    })
    expect(cond.field).toBe('type')
    expect(cond.op).toBe('=')
    expect(cond.value).toBe('functional')
    expect(cond.logic).toBe('and')
  })

  it('optional fields are absent when not provided', () => {
    const cond: WhenCondition = WhenConditionSchema.parse({ field: 'f', op: '$null' })
    expect('value' in cond).toBe(false)
    expect('logic' in cond).toBe(false)
  })
})

describe('StatusAgentEntry type', () => {
  it('entry with array when is typed correctly', () => {
    const entry: StatusAgentEntry = StatusAgentEntrySchema.parse({
      agent: 'my-agent',
      when: [
        { field: 'type', op: '=', value: 'functional' },
        { field: 'type', op: '=', value: 'technical', logic: 'or' },
      ],
      onFinish: '$set:status=done',
    })
    expect(entry.agent).toBe('my-agent')
    expect(Array.isArray(entry.when)).toBe(true)
    expect(entry.onFinish).toBe('$set:status=done')
  })

  it('entry with legacy record when is typed correctly', () => {
    const entry: StatusAgentEntry = StatusAgentEntrySchema.parse({
      agent: 'my-agent',
      when: { type: 'functional' },
    })
    expect(entry.agent).toBe('my-agent')
    expect(Array.isArray(entry.when)).toBe(false)
    expect((entry.when as Record<string, string>)['type']).toBe('functional')
  })

  it('entry without when is default (always runs)', () => {
    const entry: StatusAgentEntry = StatusAgentEntrySchema.parse({ agent: 'default-agent' })
    expect(entry.when).toBeUndefined()
    expect(entry.onProcess).toBeUndefined()
    expect(entry.onFinish).toBeUndefined()
    expect(entry.onError).toBeUndefined()
  })
})
