import { describe, expect, it } from 'vitest'
import { Condition } from '../../../condition/Condition.js'
import { EventFilter } from '../../../condition/EventFilter.js'
import { createEvent } from '../../../events/DomainEvent.js'
import { Pause } from '../Pause.js'

describe('Pause as JSON', () => {
  it('round-trips: the restored pause wakes on the same events and expires at the same time', () => {
    const original = new Pause(
      'wait-ci',
      [
        {
          name: 'green',
          filter: new EventFilter({
            on: ['check_suite'],
            when: [new Condition({ field: 'conclusion', op: 'eq', value: 'success' })],
          }),
        },
        { name: 'any-comment', filter: new EventFilter({ on: ['comment'] }) },
      ],
      1_000,
    )
    const json = JSON.parse(JSON.stringify(original.toJSON()))
    expect(json).toEqual({
      pauseId: 'wait-ci',
      branches: [
        {
          name: 'green',
          on: ['check_suite'],
          when: [{ field: 'conclusion', op: 'eq', value: 'success', logic: 'and' }],
        },
        { name: 'any-comment', on: ['comment'], when: [] },
      ],
      expiresAt: 1_000,
    })

    const restored = Pause.fromJSON(json)
    expect(restored.match(createEvent('check_suite', { conclusion: 'success' }))).toBe('green')
    expect(restored.match(createEvent('check_suite', { conclusion: 'failure' }))).toBeUndefined()
    expect(restored.match(createEvent('comment', {}))).toBe('any-comment')
    expect(restored.expired(1_000)).toBe(true)
    expect(restored.describe()).toBe(original.describe())
  })

  it('a pause without timeout has no expiresAt', () => {
    const json = new Pause('p', [{ name: 'b', filter: new EventFilter({ on: ['x'] }) }]).toJSON()
    expect('expiresAt' in json).toBe(false)
    expect(Pause.fromJSON(json).expired(Number.MAX_SAFE_INTEGER)).toBe(false)
  })
})
