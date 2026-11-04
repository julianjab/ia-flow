import { describe, expect, it } from 'vitest'
import { createEvent, type DomainEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { MAX_TRANSIENT_RETRIES } from '../../pipeline/transient.js'
import { Engine } from '../Engine.js'
import { ExecutionStore } from '../ExecutionStore.js'
import { InMemoryExecutionRepository } from '../InMemoryExecutionRepository.js'
import { TRANSIENT_RETRY_BASE_MS } from '../TransientRetries.js'

const TASK = { projectId: 'p', issue: 7 }
const event = (type: string): DomainEvent => createEvent(type, {}, { scope: TASK })
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

const secondaryRateLimit = (retryAfterMs?: number) =>
  Object.assign(new Error('GitHub API → 403: secondary rate limit'), {
    transient: true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  })

/** Una pipeline `move` cuyo paso falla como diga `outcomes` (en orden; después anda), con su
 *  `onError` (el `+blocked`) anotado; y otra, `label`, que siempre anda. */
function setup(outcomes: Array<Error | undefined>, opts: { continueOnError?: boolean } = {}) {
  const calls: string[] = []
  const blocked: string[] = []
  const move = new Pipeline({
    id: 'move',
    on: ['card'],
    do: [
      new FunctionAction({
        id: 'move_status',
        ...(opts.continueOnError ? { continueOnError: true } : {}),
        fn: (ctx) => {
          calls.push(`move#${ctx.event.transientRetries ?? 0}`)
          const outcome = outcomes.shift()
          if (outcome) throw outcome
        },
      }),
      new FunctionAction({ id: 'after', fn: () => void calls.push('after') }),
    ],
    onError: { to: new FunctionAction({ id: 'blocked', fn: () => void blocked.push('+blocked') }) },
  })
  const label = new Pipeline({
    id: 'label',
    on: ['card'],
    do: [new FunctionAction({ id: 'label', fn: () => void calls.push('label') })],
  })
  const engine = new Engine({
    bus: new EventBus(),
    pipelines: { list: () => [move, label] },
    executions: new ExecutionStore({ repository: new InMemoryExecutionRepository() }),
  })
  return { engine, calls, blocked }
}

describe('a run that fails on infrastructure (a GitHub secondary rate limit)', () => {
  it('does not run its onError and is retried after the backoff, only for the pipeline that failed', async () => {
    const { engine, calls, blocked } = setup([secondaryRateLimit()])

    await engine.dispatch(event('card')).catch(() => {})
    expect(blocked).toEqual([])
    expect(engine.pendingRetries).toBe(1)
    expect(calls.sort()).toEqual(['label', 'move#0'])

    // Antes del backoff no pasa nada.
    engine.tick(Date.now() + TRANSIENT_RETRY_BASE_MS / 2)
    await flush()
    expect(calls).toHaveLength(2)

    engine.tick(Date.now() + TRANSIENT_RETRY_BASE_MS + 1000)
    await flush()
    expect(calls.slice(2)).toEqual(['move#1', 'after'])
    expect(blocked).toEqual([])
    expect(engine.pendingRetries).toBe(0)
  })

  it('honors the wait the upstream asked for when it is longer than the backoff', async () => {
    const { engine, calls } = setup([secondaryRateLimit(5 * TRANSIENT_RETRY_BASE_MS)])

    await engine.dispatch(event('card')).catch(() => {})
    engine.tick(Date.now() + 2 * TRANSIENT_RETRY_BASE_MS)
    await flush()
    expect(calls.filter((call) => call.startsWith('move'))).toEqual(['move#0'])

    engine.tick(Date.now() + 6 * TRANSIENT_RETRY_BASE_MS)
    await flush()
    expect(calls.filter((call) => call.startsWith('move'))).toEqual(['move#0', 'move#1'])
  })

  it('after the last retry it is a failure like any other: runs its onError once', async () => {
    const failures = Array.from({ length: MAX_TRANSIENT_RETRIES + 1 }, () => secondaryRateLimit())
    const { engine, calls, blocked } = setup(failures)

    await engine.dispatch(event('card')).catch(() => {})
    for (let i = 0; i < MAX_TRANSIENT_RETRIES; i++) {
      engine.tick(Date.now() + 60 * TRANSIENT_RETRY_BASE_MS)
      await flush()
    }

    expect(calls.filter((call) => call.startsWith('move'))).toEqual([
      'move#0',
      'move#1',
      'move#2',
      'move#3',
    ])
    expect(blocked).toEqual(['+blocked'])
    expect(engine.pendingRetries).toBe(0)
  })

  it('a failure that is not transient runs its onError right away and is not retried', async () => {
    const { engine, blocked } = setup([new Error('404 Not Found')])

    await engine.dispatch(event('card')).catch(() => {})
    expect(blocked).toEqual(['+blocked'])
    expect(engine.pendingRetries).toBe(0)
  })

  it('an optional step (continueOnError) keeps going without the onError and is not retried', async () => {
    const { engine, calls, blocked } = setup([secondaryRateLimit()], { continueOnError: true })

    await engine.dispatch(event('card'))
    expect(calls).toContain('after')
    expect(blocked).toEqual([])
    expect(engine.pendingRetries).toBe(0)
  })
})
