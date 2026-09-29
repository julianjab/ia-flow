import { describe, expect, it } from 'vitest'
import { Condition } from '../../condition/Condition.js'
import { createEvent } from '../../events/DomainEvent.js'
import { PipelineTrigger } from '../PipelineTrigger.js'

describe('PipelineTrigger', () => {
  const trigger = new PipelineTrigger({
    on: ['issue.moved'],
    scope: { projectId: 'p' },
    when: [new Condition({ field: 'status', op: 'eq', value: 'Build' })],
  })
  const event = (type: string, payload: Record<string, unknown>, scope?: Record<string, unknown>) =>
    createEvent(type, payload, scope ? { scope } : {})

  it('explains the first reason an event does not start the pipeline', () => {
    expect(trigger.explainMismatch(event('other', {}))).toBe('no escucha "other"')
    expect(trigger.explainMismatch(event('issue.moved', { status: 'Build' }))).toBe(
      'scope.projectId: esperaba "p", vino nada',
    )
    expect(
      trigger.explainMismatch(event('issue.moved', { status: 'Review' }, { projectId: 'p' })),
    ).toMatch(/^no cumple: status eq "Build"/)
    expect(
      new PipelineTrigger({ on: ['issue.moved'], enabled: false }).explainMismatch(
        event('issue.moved', {}),
      ),
    ).toBe('deshabilitada')
  })

  it('matches an event of its type, scope and when', () => {
    expect(trigger.matches(event('issue.moved', { status: 'Build' }, { projectId: 'p' }))).toBe(
      true,
    )
  })

  it('needs at least one event type', () => {
    expect(() => new PipelineTrigger({ on: [] })).toThrow(/al menos un tipo/)
  })
})
