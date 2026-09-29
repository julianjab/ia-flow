import { describe, expect, it, vi } from 'vitest'
import { createEvent } from '../DomainEvent.js'
import { EventBus } from '../EventBus.js'

describe('EventBus', () => {
  it('delivers an event to a handler subscribed on its exact type', async () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.subscribe('github.issue.opened', handler)

    const event = createEvent('github.issue.opened', {})
    await bus.publish(event)

    expect(handler).toHaveBeenCalledWith(event)
  })

  it('delivers every event to a "*" handler', async () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.subscribe('*', handler)

    await bus.publish(createEvent('a', {}))
    await bus.publish(createEvent('b', {}))

    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('does not deliver to handlers of a different type', async () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.subscribe('slack.message', handler)

    await bus.publish(createEvent('github.issue.opened', {}))

    expect(handler).not.toHaveBeenCalled()
  })

  it('unsubscribe stops further deliveries', async () => {
    const bus = new EventBus()
    const handler = vi.fn()
    const unsubscribe = bus.subscribe('a', handler)

    unsubscribe()
    await bus.publish(createEvent('a', {}))

    expect(handler).not.toHaveBeenCalled()
  })

  it('runs handlers of the same event concurrently, not sequentially', async () => {
    const bus = new EventBus()
    const order: string[] = []
    bus.subscribe('a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('slow')
    })
    bus.subscribe('a', () => {
      order.push('fast')
    })

    await bus.publish(createEvent('a', {}))

    expect(order).toEqual(['fast', 'slow'])
  })

  it('publish resolves even when there are no subscribers', async () => {
    const bus = new EventBus()
    await expect(bus.publish(createEvent('nobody-listens', {}))).resolves.toBeUndefined()
  })

  it('a rejecting handler surfaces via an AggregateError without blocking siblings', async () => {
    const bus = new EventBus()
    const sibling = vi.fn()
    bus.subscribe('a', () => {
      throw new Error('boom')
    })
    bus.subscribe('a', sibling)

    await expect(bus.publish(createEvent('a', {}))).rejects.toThrow(AggregateError)
    expect(sibling).toHaveBeenCalled()
  })
})
