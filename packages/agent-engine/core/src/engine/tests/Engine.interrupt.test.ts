import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry, type ProviderRunContext } from '../../agent/Provider.js'
import { YIELD_TOOL_NAME } from '../../agent/YieldTool.js'
import type { EventFilterProps } from '../../condition/EventFilter.js'
import { createEvent, type DomainEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { type IfRunning, Pipeline } from '../../pipeline/Pipeline.js'
import { INTERRUPTION_STEP, type Runnable } from '../../pipeline/Runnable.js'
import { Engine, type EngineOptions, scopeExecutionKey } from '../Engine.js'
import { InMemoryExecutionStore } from '../InMemoryExecutionStore.js'
import { StaticPipelineSource } from '../PipelineSource.js'

const TASK = { projectId: 'p', repo: 'la-haus/subscriptions', issue: 1640 }
const event = (type: string, payload: Record<string, unknown> = {}): DomainEvent =>
  createEvent(type, payload, { scope: TASK, depth: 1 })

/** Lo que pasó, en orden, en todo el test. */
function journal() {
  const log: string[] = []
  const step = (id: string, record?: (ctx: Parameters<FunctionAction['fn']>[0]) => string) =>
    new FunctionAction({
      id,
      fn: (ctx) => {
        log.push(record ? record(ctx) : id)
      },
    })
  return { log, step }
}

/**
 * Un implementer que queda corriendo hasta que el test lo suelta (`release`). Al soltarlo lee su
 * inbox como el provider real y, si le avisaron que lo interrumpieron, cede el turno con
 * `yield_turn` — salvo `obeys: false`, que termina con su salida como si no hubiera leído nada.
 */
function heldImplementer(
  options: {
    obeys?: boolean
    injects?: EventFilterProps[]
    routes?: ConstructorParameters<typeof Agent>[0]['routes']
    onInterrupt?: ConstructorParameters<typeof Agent>[0]['onInterrupt']
  } = {},
) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  const inbox: string[][] = []
  const registry = new ProviderRegistry().register({
    id: 'fake',
    run: async (ctx: ProviderRunContext) => {
      started()
      await gate
      const read = (await ctx.inbox?.()) ?? []
      inbox.push(read)
      const yieldTool = ctx.tools.find((tool) => tool.name === YIELD_TOOL_NAME)
      if (options.obeys !== false && read.some((m) => m.includes('Interrupción')) && yieldTool) {
        await yieldTool.handler({ progress: 'tests en rojo escritos; falta el endpoint' })
        return { outcome: 'success' }
      }
      await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
      return { outcome: 'success', summary: 'terminé el endpoint' }
    },
  })
  const agent = new Agent(
    {
      id: 'implementer',
      provider: 'fake',
      prompt: 'p',
      ...(options.injects ? { injects: options.injects } : {}),
      ...(options.routes ? { routes: options.routes } : {}),
      ...(options.onInterrupt !== undefined ? { onInterrupt: options.onInterrupt } : {}),
    },
    registry,
  )
  return { agent, release, running, inbox }
}

function reviewer(log: string[]) {
  return new Agent(
    { id: 'reviewer', provider: 'rev', prompt: 'p' },
    new ProviderRegistry().register({
      id: 'rev',
      run: async () => {
        log.push('reviewer')
        return { outcome: 'success' }
      },
    }),
  )
}

function engineWith(pipelines: Pipeline[], options: Partial<EngineOptions> = {}) {
  const store = new InMemoryExecutionStore()
  const engine = new Engine({
    bus: new EventBus(),
    pipelines: new StaticPipelineSource(pipelines),
    executions: store,
    formatMessage: (e) => `${e.type}: ${String((e.payload as { body?: string }).body)}`,
    ...options,
  })
  return { engine, store }
}

/** El despacho decide después de leer las reglas (asincrónico): recién ahí interrumpe. */
const decided = () => new Promise((resolve) => setTimeout(resolve, 0))

const rule = (id: string, on: string, steps: Runnable[], ifRunning?: IfRunning) =>
  new Pipeline({ id, on: [on], do: steps, ...(ifRunning ? { ifRunning } : {}) })

/** Lo que el `onInterrupt` ve en `steps.interruption`, como una línea. */
const comment = (ctx: Parameters<FunctionAction['fn']>[0]) => {
  const report = ctx.steps[INTERRUPTION_STEP] as Record<string, string>
  return `comment: ${report.agent} por ${report.by} (${report.event}) — ${report.reason} — quedó en: ${report.progress}`
}

describe('Engine — ifRunning: interrupt', () => {
  it('the running agent yields, its exits and the rest of do[] do not run, onInterrupt does, and the next rule runs after', async () => {
    const { log, step } = journal()
    const implementer = heldImplementer({
      routes: { done: { to: step('move-to-review') } },
      onInterrupt: { to: step('comment', comment) },
    })
    const { engine, store } = engineWith([
      rule('build', 'build', [implementer.agent, step('after-agent')]),
      rule('review', 'status_changed', [reviewer(log)], 'interrupt'),
    ])

    const build = engine.dispatch(event('build'))
    await implementer.running
    const review = engine.dispatch(event('status_changed', { status: 'Review' }))
    await decided()
    const execution = store.current(scopeExecutionKey(event('any')) as string)
    expect(execution?.interruption?.by).toBe('review')

    implementer.release()
    await Promise.all([build, review])

    expect(implementer.inbox[0]?.[0]).toMatch(/Interrupción: llegó "status_changed"/)
    expect(log).toEqual([
      'comment: implementer por review (status_changed) — llegó "status_changed" y va a correr "review" — quedó en: tests en rojo escritos; falta el endpoint',
      'reviewer',
    ])
    expect(execution?.status).toBe('superseded')
    expect(execution?.toRecord().closeReason).toBe('interrupted by review')
  })

  it('an agent that ignores the notice still does not follow its exit: its summary is where it stopped', async () => {
    const { log, step } = journal()
    const implementer = heldImplementer({
      obeys: false,
      routes: { done: { to: step('move-to-review') } },
      onInterrupt: { to: step('comment', comment) },
    })
    const { engine } = engineWith(
      [
        rule('build', 'build', [implementer.agent]),
        rule('review', 'status_changed', [reviewer(log)], 'interrupt'),
      ],
      { interruptReason: () => 'la tarjeta pasó a Review' },
    )

    const build = engine.dispatch(event('build'))
    await implementer.running
    const review = engine.dispatch(event('status_changed'))
    await decided()
    implementer.release()
    await Promise.all([build, review])

    expect(log).toEqual([
      'comment: implementer por review (status_changed) — la tarjeta pasó a Review — quedó en: terminé el endpoint',
      'reviewer',
    ])
  })

  it('an event the system produced itself does not interrupt: the agent finishes, then the rule runs', async () => {
    const { log, step } = journal()
    const implementer = heldImplementer({
      routes: { done: { to: step('move-to-review') } },
      onInterrupt: { to: step('comment', comment) },
    })
    const { engine } = engineWith(
      [
        rule('build', 'build', [implementer.agent]),
        rule('review', 'status_changed', [reviewer(log)], 'interrupt'),
      ],
      { selfOriginated: (e) => (e.payload as { sender?: string }).sender === 'ia-flow[bot]' },
    )

    const build = engine.dispatch(event('build'))
    await implementer.running
    const review = engine.dispatch(event('status_changed', { sender: 'ia-flow[bot]' }))
    await decided()
    implementer.release()
    await Promise.all([build, review])

    expect(implementer.inbox).toEqual([[]])
    expect(log).toEqual(['move-to-review', 'reviewer'])
  })

  it('with no agent in its loop (an action running) there is nobody to tell: the rule just waits', async () => {
    const { log, step } = journal()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const moving = new Promise<void>((resolve) => {
      started = resolve
    })
    const slowMove = new FunctionAction({
      id: 'move-to-review',
      fn: async () => {
        started()
        await gate
        log.push('move-to-review')
      },
    })
    // Un agente que ya terminó: la ejecución sigue con la acción lenta, sin nadie en su loop.
    const quick = new Agent(
      { id: 'implementer', provider: 'quick', prompt: 'p' },
      new ProviderRegistry().register({ id: 'quick', run: async () => ({ outcome: 'success' }) }),
    )
    const { engine } = engineWith([
      rule('build', 'build', [quick, slowMove, step('after-move')]),
      rule('review', 'status_changed', [reviewer(log)], 'interrupt'),
    ])

    const build = engine.dispatch(event('build'))
    await moving
    const review = engine.dispatch(event('status_changed'))
    await decided()
    release()
    await Promise.all([build, review])

    expect(log).toEqual(['move-to-review', 'after-move', 'reviewer'])
  })

  it('a comment the agent accepts is still injected, without interrupting it', async () => {
    const { log, step } = journal()
    const implementer = heldImplementer({
      injects: [{ on: ['issue_comment'] }],
      routes: { done: { to: step('move-to-review') } },
      onInterrupt: { to: step('comment', comment) },
    })
    const { engine } = engineWith([
      rule('build', 'build', [implementer.agent]),
      rule('comment-build', 'issue_comment', [implementer.agent], 'interrupt'),
    ])

    const build = engine.dispatch(event('build'))
    await implementer.running
    const outcome = await engine.dispatch(event('issue_comment', { body: 'usá el enum' }))
    implementer.release()
    await build

    expect(outcome).toBe('injected')
    expect(implementer.inbox).toEqual([['issue_comment: usá el enum']])
    expect(log).toEqual(['move-to-review'])
  })

  it('without onInterrupt the agent just stops', async () => {
    const { log, step } = journal()
    const implementer = heldImplementer({ routes: { done: { to: step('move-to-review') } } })
    const { engine } = engineWith([
      rule('build', 'build', [implementer.agent]),
      rule('review', 'status_changed', [reviewer(log)], 'interrupt'),
    ])

    const build = engine.dispatch(event('build'))
    await implementer.running
    const review = engine.dispatch(event('status_changed'))
    await decided()
    implementer.release()
    await Promise.all([build, review])

    expect(log).toEqual(['reviewer'])
  })

  it('the pipeline can set onInterrupt for every agent in it', async () => {
    const { log, step } = journal()
    const implementer = heldImplementer({ routes: { done: { to: step('move-to-review') } } })
    const { engine } = engineWith([
      new Pipeline({
        id: 'build',
        on: ['build'],
        do: [implementer.agent],
        onInterrupt: { to: step('comment', comment) },
      }),
      rule('review', 'status_changed', [reviewer(log)], 'interrupt'),
    ])

    const build = engine.dispatch(event('build'))
    await implementer.running
    const review = engine.dispatch(event('status_changed'))
    await decided()
    implementer.release()
    await Promise.all([build, review])

    expect(log[0]).toMatch(/^comment: implementer por review/)
    expect(log[1]).toBe('reviewer')
  })

  it('interruptOn: only the events it lists interrupt; the rest of the pipeline events wait', async () => {
    const { log, step } = journal()
    const implementer = heldImplementer({
      routes: { done: { to: step('move-to-review') } },
      onInterrupt: { to: step('comment', comment) },
    })
    const { engine } = engineWith([
      rule('build', 'build', [implementer.agent]),
      new Pipeline({
        id: 'column',
        on: ['status_changed', 'card_edited'],
        do: [reviewer(log)],
        ifRunning: 'interrupt',
        interruptOn: [{ on: ['status_changed'] }],
      }),
    ])

    const build = engine.dispatch(event('build'))
    await implementer.running
    const edited = engine.dispatch(event('card_edited'))
    await decided()
    implementer.release()
    await Promise.all([build, edited])
    // Una edición de la card no corta al agente: termina y sigue su salida.
    expect(log).toEqual(['move-to-review', 'reviewer'])
  })
})
