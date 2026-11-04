import { describe, expect, it } from 'vitest'
import { createEvent } from '../../events/DomainEvent.js'
import type { ParallelGroup } from '../ParallelGroup.js'
import { GroupFailure } from '../StepRunner.js'
import {
  isTransient,
  MAX_TRANSIENT_RETRIES,
  markDeferred,
  markScheduled,
  needsRetry,
  retriesLeft,
  retryAfterMsOf,
} from '../transient.js'

const transient = (retryAfterMs?: number) =>
  Object.assign(new Error('403 secondary rate limit'), {
    transient: true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  })

describe('isTransient', () => {
  it('reads the flag on the error or on its cause', () => {
    expect(isTransient(transient())).toBe(true)
    expect(isTransient(new Error('envuelto', { cause: transient() }))).toBe(true)
    expect(isTransient(new Error('404'))).toBe(false)
    expect(isTransient('texto')).toBe(false)
  })

  it('an AggregateError is transient only if all its causes are', () => {
    expect(isTransient(new AggregateError([transient(), transient()]))).toBe(true)
    expect(isTransient(new AggregateError([transient(), new Error('404')]))).toBe(false)
    expect(isTransient(new AggregateError([]))).toBe(false)
  })
})

describe('retryAfterMsOf', () => {
  it('takes the longest wait any cause asked for', () => {
    expect(retryAfterMsOf(transient(5000))).toBe(5000)
    expect(retryAfterMsOf(new AggregateError([transient(1000), transient(9000)]))).toBe(9000)
    expect(retryAfterMsOf(new Error('x', { cause: transient(3000) }))).toBe(3000)
    expect(retryAfterMsOf(transient())).toBeUndefined()
  })
})

describe('retriesLeft', () => {
  it('counts the retries the event already had', () => {
    const event = createEvent('x', {})
    expect(retriesLeft(event)).toBe(true)
    expect(retriesLeft({ ...event, transientRetries: MAX_TRANSIENT_RETRIES - 1 })).toBe(true)
    expect(retriesLeft({ ...event, transientRetries: MAX_TRANSIENT_RETRIES })).toBe(false)
  })
})

describe('GroupFailure', () => {
  const group = { id: 'gate' } as ParallelGroup
  it('is transient when every failure is and no member voted', () => {
    expect(new GroupFailure(group, ['a', 'b'], [], [transient(), transient()]).transient).toBe(true)
    expect(isTransient(new GroupFailure(group, ['a'], [], [transient()]))).toBe(true)
  })

  it('is not if a member voted, or one failure is not transient', () => {
    expect(new GroupFailure(group, ['a'], [], [transient()], true).transient).toBe(false)
    expect(new GroupFailure(group, ['a', 'b'], [], [transient(), undefined]).transient).toBe(false)
  })
})

describe('needsRetry', () => {
  it('only an error some step deferred, and not one whose causes are all scheduled already', () => {
    const child = transient()
    expect(needsRetry(child)).toBe(false)
    markDeferred(child)
    expect(needsRetry(child)).toBe(true)
    markScheduled(child)
    expect(needsRetry(child)).toBe(false)
    // El `emit` del padre: falla porque falló el hijo, ya programado.
    const parent = new AggregateError([new AggregateError([child])])
    markDeferred(parent)
    expect(needsRetry(parent)).toBe(false)
  })
})
