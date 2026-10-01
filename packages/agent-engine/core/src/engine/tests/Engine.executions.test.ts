import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry, type ProviderRunContext } from '../../agent/Provider.js'
import { Condition } from '../../condition/Condition.js'
import type { EventFilterProps } from '../../condition/EventFilter.js'
import { createEvent, type DomainEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { EmitAction } from '../../pipeline/actions/EmitAction.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { type IfRunning, Pipeline } from '../../pipeline/Pipeline.js'
import { Engine, scopeExecutionKey } from '../Engine.js'
import { InMemoryExecutionStore } from '../InMemoryExecutionStore.js'
import { StaticPipelineSource } from '../PipelineSource.js'

const TASK = { projectId: 'p', repo: 'la-haus/subscriptions', issue: 1640 }
const event = (type: string, payload: Record<string, unknown> = {}, depth = 1): DomainEvent =>
  createEvent(type, payload, { scope: TASK, depth })

/**
 * Un implementer que queda corriendo hasta que el test lo suelta (`release`), y que ANTES de
 * terminar lee su inbox — como el provider real, que lo vacía antes de cada vuelta. Acepta que
 * le inyecten comentarios (`injects`), salvo que el test diga otra cosa.
 */
function heldImplementer(options: { drains?: boolean; injects?: EventFilterProps[] } = {}) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  const inbox: string[][] = []
  const runs: string[] = []
  const registry = new ProviderRegistry().register({
    id: 'fake',
    run: async (ctx: ProviderRunContext) => {
      runs.push(ctx.ctx.pipelineId)
      started()
      await gate
      if (options.drains !== false) inbox.push(ctx.inbox?.() ?? [])
      return { outcome: 'success' }
    },
  })
  const agent = new Agent(
    {
      id: 'implementer',
      provider: 'fake',
      prompt: 'p',
      injects: options.injects ?? [{ on: ['issue_comment'] }],
    },
    registry,
  )
  return { agent, release, running, inbox, runs }
}

function engineWith(pipelines: Pipeline[], store = new InMemoryExecutionStore()) {
  return {
    store,
    engine: new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource(pipelines),
      executions: store,
      formatMessage: (e) => `${e.type}: ${String((e.payload as { body?: string }).body)}`,
    }),
  }
}

const rule = (id: string, on: string, agent: Agent, ifRunning?: IfRunning) =>
  new Pipeline({ id, on: [on], do: [agent], ...(ifRunning ? { ifRunning } : {}) })

describe('Engine with executions', () => {
  it('injects an event its running step accepts, instead of starting another run', async () => {
    const implementer = heldImplementer()
    const { engine } = engineWith([
      rule('build', 'build', implementer.agent),
      rule('comment-build', 'issue_comment', implementer.agent),
    ])

    const build = engine.dispatch(event('build'))
    await implementer.running
    const outcome = await engine.dispatch(event('issue_comment', { body: 'usá el enum' }))
    implementer.release()
    await build

    expect(outcome).toBe('injected')
    expect(implementer.runs).toEqual(['build'])
    expect(implementer.inbox).toEqual([['issue_comment: usá el enum']])
  })

  it('a running step that does not accept the event lets it wait for the task', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const reviewing = new Promise<void>((resolve) => {
      started = resolve
    })
    const reviewerInbox: string[][] = []
    const reviewer = new Agent(
      { id: 'reviewer', provider: 'rev', prompt: 'p' },
      new ProviderRegistry().register({
        id: 'rev',
        run: async (ctx) => {
          started()
          await gate
          reviewerInbox.push(ctx.inbox?.() ?? [])
          return { outcome: 'success' }
        },
      }),
    )
    const implementerRuns: string[] = []
    const implementer = new Agent(
      { id: 'implementer', provider: 'impl', prompt: 'p' },
      new ProviderRegistry().register({
        id: 'impl',
        run: async (ctx) => {
          implementerRuns.push(ctx.ctx.pipelineId)
          return { outcome: 'success' }
        },
      }),
    )
    const { engine } = engineWith([
      rule('review', 'review', reviewer),
      rule('comment-review', 'issue_comment', implementer),
    ])

    const review = engine.dispatch(event('review'))
    await reviewing
    const comment = engine.dispatch(event('issue_comment', { body: 'para el implementer' }))
    release()

    expect(await comment).toBe('dispatched')
    await review
    expect(reviewerInbox).toEqual([[]])
    expect(implementerRuns).toEqual(['comment-review'])
  })

  it('the step decides with its own when: a comment it filters out waits', async () => {
    const implementer = heldImplementer({
      injects: [
        {
          on: ['issue_comment'],
          when: [new Condition({ field: 'body', op: 'neq', value: 'del bot' })],
        },
      ],
    })
    const { engine } = engineWith([
      rule('build', 'build', implementer.agent),
      rule('comment-build', 'issue_comment', implementer.agent),
    ])

    const build = engine.dispatch(event('build'))
    await implementer.running
    const comment = engine.dispatch(event('issue_comment', { body: 'del bot' }))
    implementer.release()
    expect(await comment).toBe('dispatched')
    await build
    expect(implementer.inbox[0]).toEqual([])
    expect(implementer.runs).toEqual(['build', 'comment-build'])
  })

  it('with no execution running, the rule starts one', async () => {
    const implementer = heldImplementer()
    const { engine } = engineWith([rule('comment-build', 'issue_comment', implementer.agent)])
    implementer.release()

    expect(await engine.dispatch(event('issue_comment', { body: 'x' }))).toBe('dispatched')
    expect(implementer.runs).toEqual(['comment-build'])
  })

  it('waits by default: the second run of a task starts after the first finishes', async () => {
    const implementer = heldImplementer()
    const { engine, store } = engineWith([
      rule('build', 'build', implementer.agent),
      rule('ci-red', 'ci', implementer.agent),
    ])

    const build = engine.dispatch(event('build'))
    await implementer.running
    const ci = engine.dispatch(event('ci'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.stats.waiting).toBe(1)

    implementer.release()
    await Promise.all([build, ci])
    expect(implementer.runs).toEqual(['build', 'ci-red'])
  })

  it('skip drops the event while the task is running', async () => {
    const implementer = heldImplementer()
    const { engine } = engineWith([
      rule('build', 'build', implementer.agent),
      rule('noise', 'label', implementer.agent, 'skip'),
    ])

    const build = engine.dispatch(event('build'))
    await implementer.running
    expect(await engine.dispatch(event('label'))).toBe('skipped')
    implementer.release()
    await build
    expect(implementer.runs).toEqual(['build'])
  })

  it('an event born inside the running execution runs without waiting for it', async () => {
    const implementer = heldImplementer()
    const ran: string[] = []
    const helper = new Agent(
      { id: 'helper', provider: 'fake-helper', prompt: 'p' },
      new ProviderRegistry().register({
        id: 'fake-helper',
        run: async () => {
          ran.push('helper')
          return { outcome: 'success' }
        },
      }),
    )
    const { engine, store } = engineWith([
      rule('build', 'build', implementer.agent),
      rule('nested', 'derived', helper),
    ])
    const key = scopeExecutionKey(event('build')) as string

    const build = engine.dispatch(event('build'))
    await implementer.running
    const own = createEvent(
      'derived',
      {},
      {
        scope: TASK,
        depth: 2,
        executionId: store.current(key)?.id,
      },
    )
    await engine.dispatch(own)
    expect(ran).toEqual(['helper'])
    implementer.release()
    await build
  })

  it('an event born in ANOTHER execution queues for the task without blocking its emitter', async () => {
    const implementer = heldImplementer()
    const ran: string[] = []
    const helper = new Agent(
      { id: 'helper', provider: 'fake-helper', prompt: 'p' },
      new ProviderRegistry().register({
        id: 'fake-helper',
        run: async () => {
          ran.push('helper')
          return { outcome: 'success' }
        },
      }),
    )
    const { engine } = engineWith([
      rule('build', 'build', implementer.agent),
      rule('nested', 'derived', helper),
    ])

    const build = engine.dispatch(event('build'))
    await implementer.running
    // Vuelve enseguida (no espera el turno de la task), pero la corrida queda en cola.
    expect(
      await engine.dispatch(
        createEvent('derived', {}, { scope: TASK, depth: 5, executionId: 'exec-otra' }),
      ),
    ).toBe('dispatched')
    expect(ran).toEqual([])
    implementer.release()
    await build
    await vi.waitFor(() => expect(ran).toEqual(['helper']))
  })

  it('an execution that emits to another task does not deadlock under a cap of one', async () => {
    const ran: string[] = []
    const agent = (id: string) =>
      new Agent(
        { id, provider: `p-${id}`, prompt: 'p' },
        new ProviderRegistry().register({
          id: `p-${id}`,
          run: async () => {
            ran.push(id)
            return { outcome: 'success' }
          },
        }),
      )
    const emitter = new Pipeline({
      id: 'emitter',
      on: ['start'],
      do: [
        agent('first'),
        new EmitAction({ type: 'follow-up', scope: { projectId: 'p', issue: 'otra-task' } }),
      ],
    })
    const followUp = rule('follow-up', 'follow-up', agent('second'))
    const { engine } = engineWith(
      [emitter, followUp],
      new InMemoryExecutionStore({ maxConcurrent: 1 }),
    )
    engine.start()

    expect(await engine.dispatch(event('start'))).toBe('dispatched')
    await vi.waitFor(() => expect(ran).toEqual(['first', 'second']))
  })

  it('skip also drops the event while the task is waiting for its turn', async () => {
    const implementer = heldImplementer()
    const other = heldImplementer()
    const store = new InMemoryExecutionStore({ maxConcurrent: 1 })
    const { engine } = engineWith(
      [
        rule('other-task', 'other', other.agent),
        rule('build', 'build', implementer.agent),
        rule('noise', 'label', implementer.agent, 'skip'),
      ],
      store,
    )

    // Otra task ocupa el único lugar: el build de ESTA task queda esperando turno.
    const blocker = engine.dispatch(
      createEvent('other', {}, { scope: { issue: 'otra' }, depth: 1 }),
    )
    await other.running
    const build = engine.dispatch(event('build'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(await engine.dispatch(event('label'))).toBe('skipped')
    other.release()
    implementer.release()
    await Promise.all([blocker, build])
    expect(implementer.runs).toEqual(['build'])
  })

  it('re-dispatches what the agent never read to the agent rules — reactions ran once already', async () => {
    const implementer = heldImplementer({ drains: false })
    const plain: string[] = []
    const { engine } = engineWith([
      rule('build', 'build', implementer.agent),
      rule('comment-build', 'issue_comment', implementer.agent),
      new Pipeline({
        id: 'react',
        on: ['issue_comment'],
        do: [new FunctionAction({ fn: () => plain.push('react') })],
      }),
    ])

    const build = engine.dispatch(event('build'))
    await implementer.running
    expect(await engine.dispatch(event('issue_comment', { body: 'tarde' }))).toBe('dispatched')
    // Inyectado, pero la reacción sin agentes corre igual.
    expect(plain).toEqual(['react'])
    expect(implementer.runs).toEqual(['build'])
    implementer.release()
    await build

    await vi.waitFor(() => expect(implementer.runs).toEqual(['build', 'comment-build']))
    // El re-despacho no la repite.
    expect(plain).toEqual(['react'])
  })

  it('leaves pipelines without agents and events without a task untouched', async () => {
    const implementer = heldImplementer()
    const actions: string[] = []
    const plain = new Pipeline({
      id: 'plain',
      on: ['label'],
      ifRunning: 'skip',
      do: [new FunctionAction({ fn: () => actions.push('plain') })],
    })
    const { engine } = engineWith([
      rule('build', 'build', implementer.agent),
      plain,
      rule('any', 'untracked', implementer.agent, 'skip'),
    ])

    const build = engine.dispatch(event('build'))
    await implementer.running
    await engine.dispatch(event('label'))
    expect(actions).toEqual(['plain'])

    implementer.release()
    await build
    // Sin scope no hay task: corre como siempre, aunque la regla diga `skip`.
    await engine.dispatch(createEvent('untracked', {}, { depth: 1 }))
    expect(implementer.runs).toEqual(['build', 'any'])
  })

  it('marks the execution failed when the pipeline throws, and frees the task', async () => {
    const registry = new ProviderRegistry().register({
      id: 'boom',
      run: async () => {
        throw new Error('se cayó')
      },
    })
    const agent = new Agent({ id: 'implementer', provider: 'boom', prompt: 'p' }, registry)
    const { engine, store } = engineWith([rule('build', 'build', agent)])

    await expect(engine.dispatch(event('build'))).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.current(scopeExecutionKey(event('build')) as string)).toBeUndefined()
    expect(store.stats).toEqual({ running: 0, waiting: 0, paused: 0 })
  })
})

describe('scopeExecutionKey', () => {
  it('is the same for the same task regardless of key order, and undefined without scope', () => {
    const a = createEvent('x', {}, { scope: { repo: 'r', issue: 1 } })
    const b = createEvent('y', {}, { scope: { issue: 1, repo: 'r' } })
    expect(scopeExecutionKey(a)).toBe(scopeExecutionKey(b))
    expect(scopeExecutionKey(createEvent('z', {}))).toBeUndefined()
  })
})
