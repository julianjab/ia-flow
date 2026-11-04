import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry } from '../../agent/Provider.js'
import { createEvent, type DomainEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { EmitAction } from '../../pipeline/actions/EmitAction.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { PauseAction } from '../../pipeline/actions/PauseAction.js'
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

describe('what is not retried (and so still runs its onError)', () => {
  const blockedAction = (blocked: string[]) =>
    new FunctionAction({ id: 'blocked', fn: () => void blocked.push('+blocked') })
  const failing = (id: string, calls: string[], outcomes: Array<Error | undefined>) =>
    new FunctionAction({
      id,
      fn: () => {
        calls.push(id)
        const outcome = outcomes.shift()
        if (outcome) throw outcome
      },
    })
  const engineWith = (pipelines: Pipeline[]) =>
    new Engine({
      bus: new EventBus(),
      pipelines: { list: () => pipelines },
      executions: new ExecutionStore({ repository: new InMemoryExecutionRepository() }),
    })

  it('a run that resumes a pause: there is no event to re-dispatch', async () => {
    const calls: string[] = []
    const blocked: string[] = []
    const wait = new PauseAction({
      id: 'wait-ci',
      branches: {
        green: { on: ['ci'], to: failing('to-review', calls, [secondaryRateLimit()]) },
      },
    })
    const engine = engineWith([
      new Pipeline({
        id: 'build',
        on: ['build'],
        do: [wait],
        onError: { to: blockedAction(blocked) },
      }),
    ])

    await engine.dispatch(event('build'))
    await engine.dispatch(event('ci')).catch(() => {})

    expect(calls).toEqual(['to-review'])
    expect(blocked).toEqual(['+blocked'])
    expect(engine.pendingRetries).toBe(0)
  })

  it('a run where an agent already finished: retrying would run it again', async () => {
    const calls: string[] = []
    const blocked: string[] = []
    const agent = new Agent(
      {
        id: 'implementer',
        provider: 'done',
        prompt: 'p',
        routes: { done: { to: failing('move_status', calls, [secondaryRateLimit()]) } } as never,
      },
      new ProviderRegistry().register({
        id: 'done',
        run: async (ctx) => {
          calls.push('implementer')
          await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
          return { outcome: 'success' }
        },
      }),
    )
    const engine = engineWith([
      new Pipeline({
        id: 'build',
        on: ['build'],
        do: [agent],
        onError: { to: blockedAction(blocked) },
      }),
    ])

    await engine.dispatch(event('build')).catch(() => {})

    expect(calls).toEqual(['implementer', 'move_status'])
    expect(blocked).toEqual(['+blocked'])
    expect(engine.pendingRetries).toBe(0)
  })
})

describe('a pipeline that fails inside an emit', () => {
  it('only the pipeline that failed is retried, not the one that emitted (nor its siblings)', async () => {
    const calls: string[] = []
    const outcomes: Array<Error | undefined> = [secondaryRateLimit()]
    const intake = new Pipeline({
      id: 'intake',
      on: ['webhook'],
      do: [new EmitAction({ type: 'card' })],
    })
    const move = new Pipeline({
      id: 'move',
      on: ['card'],
      do: [
        new FunctionAction({
          id: 'move_status',
          fn: () => {
            calls.push('move')
            const outcome = outcomes.shift()
            if (outcome) throw outcome
          },
        }),
      ],
    })
    const sibling = new Pipeline({
      id: 'sibling',
      on: ['card'],
      do: [new FunctionAction({ id: 'label', fn: () => void calls.push('sibling') })],
    })
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: { list: () => [intake, move, sibling] },
      executions: new ExecutionStore({ repository: new InMemoryExecutionRepository() }),
    })
    const unsubscribe = engine.start()

    await engine.dispatch(event('webhook')).catch(() => {})
    expect(engine.pendingRetries).toBe(1)

    engine.tick(Date.now() + 2 * TRANSIENT_RETRY_BASE_MS)
    await flush()
    expect(calls.sort()).toEqual(['move', 'move', 'sibling'])
    unsubscribe()
  })
})
