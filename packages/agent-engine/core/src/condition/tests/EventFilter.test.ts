import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { createEvent } from '../../events/DomainEvent.js'
import { Condition } from '../Condition.js'
import { EventFilter } from '../EventFilter.js'

describe('EventFilter', () => {
  const humanComments = new EventFilter({
    on: ['issue_comment'],
    when: [new Condition({ field: 'action', op: 'eq', value: 'created' })],
  })

  it('passes an event of one of its types that meets its when', () => {
    expect(humanComments.matches(createEvent('issue_comment', { action: 'created' }))).toBe(true)
    expect(humanComments.matches(createEvent('issue_comment', { action: 'edited' }))).toBe(false)
    expect(humanComments.matches(createEvent('label', { action: 'created' }))).toBe(false)
  })

  it('needs at least one type', () => {
    expect(() => new EventFilter({ on: [] })).toThrow(/al menos un tipo/)
  })
})

describe('Agent.accepts', () => {
  it('accepts what passes any of its injects, and nothing without them', () => {
    const implementer = new Agent({
      id: 'implementer',
      provider: 'fake',
      prompt: 'p',
      injects: [
        {
          on: ['issue_comment'],
          when: [new Condition({ field: 'action', op: 'eq', value: 'created' })],
        },
        { on: ['pull_request_review'] },
      ],
    })
    expect(implementer.accepts(createEvent('issue_comment', { action: 'created' }))).toBe(true)
    expect(implementer.accepts(createEvent('pull_request_review', {}))).toBe(true)
    expect(implementer.accepts(createEvent('issue_comment', { action: 'deleted' }))).toBe(false)

    const reviewer = new Agent({ id: 'reviewer', provider: 'fake', prompt: 'p' })
    expect(reviewer.accepts(createEvent('issue_comment', { action: 'created' }))).toBe(false)
  })
})
