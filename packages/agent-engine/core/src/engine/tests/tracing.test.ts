import { context, SpanStatusCode, trace } from '@opentelemetry/api'
import { logs } from '@opentelemetry/api-logs'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry } from '../../agent/Provider.js'
import { Condition } from '../../condition/Condition.js'
import { Engine } from '../../engine/Engine.js'
import { InMemoryExecutionStore } from '../../engine/InMemoryExecutionStore.js'
import { StaticPipelineSource } from '../../engine/PipelineSource.js'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { PauseAction } from '../../pipeline/actions/PauseAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'

const spans = new InMemorySpanExporter()
const logRecords = new InMemoryLogRecordExporter()
const contextManager = new AsyncLocalStorageContextManager()

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable())
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }),
  )
  logs.setGlobalLoggerProvider(
    new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logRecords })] }),
  )
})

afterAll(() => {
  trace.disable()
  logs.disable()
  context.disable()
})

beforeEach(() => {
  spans.reset()
  logRecords.reset()
})

const byName = (name: string): ReadableSpan => {
  const span = spans.getFinishedSpans().find((s) => s.name === name)
  if (!span)
    throw new Error(`no hay span "${name}": ${spans.getFinishedSpans().map((s) => s.name)}`)
  return span
}
const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId

/** Un agente que elige `done` y una pipeline que lo rutea a `mark` — el caso de todos los días. */
function refineSetup(provider = async () => ({ outcome: 'success' as const })) {
  const registry = new ProviderRegistry().register({
    id: 'fake',
    run: async (ctx) => {
      await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
      return provider()
    },
  })
  const mark = new FunctionAction({ id: 'mark', fn: async () => 'marcado' })
  const refiner = new Agent(
    { id: 'refiner', provider: 'fake', prompt: 'refiná', routes: { done: { to: mark } } },
    registry,
  )
  const refine = new Pipeline({
    id: 'refine',
    on: ['issue.status_changed'],
    when: [new Condition({ field: 'status', op: 'eq', value: 'Refine' })],
    do: [refiner, mark],
  })
  const build = new Pipeline({
    id: 'build',
    on: ['issue.status_changed'],
    when: [new Condition({ field: 'status', op: 'eq', value: 'Build' })],
    do: [new FunctionAction({ id: 'noop', fn: async () => null })],
  })
  const other = new Pipeline({ id: 'other', on: ['issue_comment'], do: [] })
  return new Engine({
    bus: new EventBus(),
    pipelines: new StaticPipelineSource([refine, build, other]),
  })
}

const EVENT = () =>
  createEvent(
    'issue.status_changed',
    { status: 'Refine' },
    { scope: { projectId: 'lahaus', repo: 'la-haus/front', issue: 'la-haus/front#4190' } },
  )

describe('Engine tracing', () => {
  it('hangs everything an event causes from one trace, rooted at the event', async () => {
    await refineSetup().dispatch(EVENT())

    const root = byName('event issue.status_changed')
    const pipeline = byName('pipeline refine')
    const agent = byName('agent refiner')
    const mark = byName('action mark')

    expect(parentOf(root)).toBeUndefined()
    expect(parentOf(pipeline)).toBe(root.spanContext().spanId)
    expect(parentOf(agent)).toBe(pipeline.spanContext().spanId)
    // El destino de una salida cuelga del agente que la eligió.
    expect(parentOf(mark)).toBe(agent.spanContext().spanId)
    const traceIds = new Set(spans.getFinishedSpans().map((s) => s.spanContext().traceId))
    expect(traceIds.size).toBe(1)
  })

  it('stamps the event scope on every span, so any of them filters by project/repo/issue', async () => {
    await refineSetup().dispatch(EVENT())

    for (const span of spans.getFinishedSpans()) {
      expect(span.attributes).toMatchObject({
        'ia.projectId': 'lahaus',
        'ia.repo': 'la-haus/front',
        'ia.issue': 'la-haus/front#4190',
        'ia.event.type': 'issue.status_changed',
      })
    }
    expect(byName('agent refiner').attributes['ia.pipeline.id']).toBe('refine')
    // Lo que corre por la salida de un agente sabe de qué agente viene.
    expect(byName('action mark').attributes).toMatchObject({
      'ia.agent.id': 'refiner',
      'ia.step.id': 'mark',
    })
  })

  it('records the exit the agent chose and why each step ran', async () => {
    await refineSetup().dispatch(EVENT())

    const agent = byName('agent refiner')
    expect(agent.attributes).toMatchObject({
      'ia.step.via': 'do',
      'ia.agent.exit': 'done',
      'ia.agent.outcome': 'success',
      'ia.agent.provider': 'fake',
    })
    expect(agent.events.find((e) => e.name === 'route')?.attributes).toMatchObject({
      'ia.route.exit': 'done',
      'ia.route.targets': ['mark'],
    })
    expect(byName('action mark').attributes).toMatchObject({
      'ia.step.via': 'exit:done',
      'ia.step.output': 'marcado',
    })
  })

  it('explains why each pipeline listening to the event did not run', async () => {
    await refineSetup().dispatch(EVENT())

    const root = byName('event issue.status_changed')
    const matches = root.events.filter((e) => e.name === 'pipeline.match').map((e) => e.attributes)
    expect(matches).toEqual([
      { 'ia.pipeline.id': 'refine', 'ia.pipeline.runs': true },
      {
        'ia.pipeline.id': 'build',
        'ia.pipeline.runs': false,
        'ia.pipeline.skip_reason': 'no cumple: status eq "Build" (vino "Refine")',
      },
    ])
    expect(root.attributes['ia.pipelines.run']).toEqual(['refine'])
  })

  it('keeps a trace for an event nothing reacts to — "why did nothing happen" is the common question', async () => {
    const outcome = await refineSetup().dispatch(
      createEvent('issue.status_changed', { status: 'Done' }),
    )

    expect(outcome).toBe('skipped')
    const root = byName('event issue.status_changed')
    expect(root.attributes['ia.dispatch.outcome']).toBe('skipped')
    expect(logRecords.getFinishedLogRecords().map((r) => r.body)).toContain(
      'evento "issue.status_changed": ninguna pipeline corre',
    )
  })

  it('marks the failing step as an error even when an onError handles it', async () => {
    const registry = new ProviderRegistry().register({
      id: 'fake',
      run: async () => {
        throw new Error('se cayó la API')
      },
    })
    const blocked = new FunctionAction({ id: 'blocked', fn: async () => 'bloqueado' })
    const agent = new Agent(
      { id: 'refiner', provider: 'fake', prompt: 'x', onError: { to: blocked } },
      registry,
    )
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([
        new Pipeline({ id: 'refine', on: ['e'], do: [agent, blocked] }),
      ]),
    })

    await engine.dispatch(createEvent('e', {}))

    const failed = byName('agent refiner')
    expect(failed.status.code).toBe(SpanStatusCode.ERROR)
    expect(failed.attributes['ia.step.error_handled']).toBe('onError')
    expect(byName('action blocked').attributes['ia.step.via']).toBe('onError')
    expect(byName('event e').status.code).not.toBe(SpanStatusCode.ERROR)
  })

  it('correlates logs with the trace and carries the scope attributes', async () => {
    await refineSetup().dispatch(EVENT())

    const chose = logRecords
      .getFinishedLogRecords()
      .find((r) => r.body === 'agente "refiner" eligió "done" → mark')
    expect(chose?.attributes).toMatchObject({
      'ia.issue': 'la-haus/front#4190',
      'ia.pipeline.id': 'refine',
      'ia.agent.exit': 'done',
    })
    expect(chose?.spanContext?.traceId).toBe(byName('agent refiner').spanContext().traceId)
  })
})

describe('Engine tracing — executions', () => {
  const TASK = { projectId: 'p', issue: 7 }
  const task = (type: string, body?: string) =>
    createEvent(type, body ? { body } : {}, { scope: TASK })

  /** Un implementer que queda en su loop hasta `release`; al salir lee su inbox si `drains`. */
  function setup({ drains = true, injects = true } = {}) {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const running = new Promise<void>((resolve) => {
      entered = resolve
    })
    const registry = new ProviderRegistry().register({
      id: 'held',
      run: async (ctx) => {
        entered()
        await gate
        if (drains) ctx.inbox?.()
        return { outcome: 'success' }
      },
    })
    const implementer = new Agent(
      {
        id: 'implementer',
        provider: 'held',
        prompt: 'p',
        ...(injects ? { injects: [{ on: ['issue_comment'] }] } : {}),
      },
      registry,
    )
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([
        new Pipeline({ id: 'build', on: ['build'], do: [implementer] }),
        new Pipeline({ id: 'comment-build', on: ['issue_comment'], do: [implementer] }),
      ]),
      executions: new InMemoryExecutionStore(),
    })
    return { engine, running, release }
  }

  const eventSpans = (type: string) =>
    spans.getFinishedSpans().filter((span) => span.name === `event ${type}`)
  const ifRunningOf = (span: ReadableSpan) =>
    span.events.filter((e) => e.name === 'pipeline.if_running').map((e) => e.attributes)
  const logBodies = () => logRecords.getFinishedLogRecords().map((record) => String(record.body))

  it('an injected event says which execution and agent got it, and the agent span when it read it', async () => {
    const { engine, running, release } = setup()
    const build = engine.dispatch(task('build'))
    await running
    await engine.dispatch(task('issue_comment', 'hola'))
    release()
    await build

    const [comment] = eventSpans('issue_comment')
    expect(comment?.attributes['ia.dispatch.outcome']).toBe('injected')
    expect(
      comment?.events.filter((e) => e.name === 'execution.inject').map((e) => e.attributes),
    ).toEqual([{ 'ia.execution.id': 'exec-1', 'ia.agent.id': 'implementer' }])
    expect(ifRunningOf(comment as ReadableSpan)).toEqual([
      {
        'ia.pipeline.id': 'comment-build',
        'ia.pipeline.if_running': 'injected',
        'ia.execution.id': 'exec-1',
        'ia.agent.id': 'implementer',
      },
    ])
    expect(ifRunningOf(byName('event build'))).toEqual([
      { 'ia.pipeline.id': 'build', 'ia.pipeline.if_running': 'starts' },
    ])

    const pipeline = byName('pipeline build')
    expect(pipeline.attributes).toMatchObject({ 'ia.execution.id': 'exec-1' })
    expect(pipeline.attributes['ia.execution.wait_ms']).toEqual(expect.any(Number))
    const agent = byName('agent implementer')
    // Heredado: todo lo de la corrida dice de qué ejecución es.
    expect(agent.attributes['ia.execution.id']).toBe('exec-1')
    expect(
      agent.events.filter((e) => e.name === 'inbox.delivered').map((e) => e.attributes),
    ).toEqual([{ 'ia.inbox.count': 1, 'ia.execution.id': 'exec-1' }])

    expect(logBodies()).toEqual(
      expect.arrayContaining([
        'evento "issue_comment" inyectado a implementer (exec-1)',
        'agente implementer leyó 1 mensaje(s) inyectado(s)',
        // Con la máquina cargada puede sumar "(esperó 1 ms)".
        expect.stringMatching(/^exec-1 abre: build/),
        'exec-1 cierra: done',
      ]),
    )
  })

  it('an event that waits for a busy task says behind which execution', async () => {
    const { engine, running, release } = setup({ injects: false })
    const build = engine.dispatch(task('build'))
    await running
    const comment = engine.dispatch(task('issue_comment', 'hola'))
    await Promise.resolve()
    release()
    await Promise.all([build, comment])

    expect(ifRunningOf(byName('event issue_comment'))).toEqual([
      {
        'ia.pipeline.id': 'comment-build',
        'ia.pipeline.if_running': 'waits',
        'ia.execution.id': 'exec-1',
      },
    ])
    expect(logBodies()).toContain(
      'evento "issue_comment" espera para comment-build: la task está ocupada (exec-1)',
    )
  })

  it('an unread injection is re-dispatched in a new trace that links back to the original event', async () => {
    const { engine, running, release } = setup({ drains: false })
    const build = engine.dispatch(task('build'))
    await running
    await engine.dispatch(task('issue_comment', 'tarde'))
    release()
    await build
    await vi.waitFor(() => expect(eventSpans('issue_comment')).toHaveLength(2))
    await vi.waitFor(() => byName('pipeline comment-build'))

    const [original, redelivered] = eventSpans('issue_comment') as [ReadableSpan, ReadableSpan]
    expect(parentOf(redelivered)).toBeUndefined()
    expect(redelivered.spanContext().traceId).not.toBe(byName('event build').spanContext().traceId)
    expect(redelivered.links.map((link) => link.context.spanId)).toEqual([
      original.spanContext().spanId,
    ])
    expect(redelivered.attributes).toMatchObject({
      'ia.dispatch.redelivered_from': 'exec-1',
      'ia.dispatch.outcome': 'dispatched',
      'ia.issue': 7,
    })
    // Lo de la corrida de `build` no se cuela en la traza nueva.
    expect(redelivered.attributes['ia.pipeline.id']).toBeUndefined()
    expect(parentOf(byName('pipeline comment-build'))).toBe(redelivered.spanContext().spanId)
  })
})

describe('Engine tracing — pauses', () => {
  it('the waking event says which execution it resumed and by which branch; expiry has its own trace', async () => {
    const scope = { projectId: 'p', issue: 9 }
    const done = new FunctionAction({ id: 'done', fn: () => 'ok' })
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([
        new Pipeline({
          id: 'gate',
          on: ['start'],
          do: [
            new Agent(
              { id: 'worker', provider: 'noop', prompt: 'p' },
              new ProviderRegistry().register({
                id: 'noop',
                run: async () => ({ outcome: 'success' }),
              }),
            ),
            new PauseAction({
              id: 'wait',
              branches: { green: { on: ['ci'], to: done } },
              timeout: { afterMs: 1_000 },
            }),
          ],
        }),
      ]),
      executions: new InMemoryExecutionStore(),
    })

    await engine.dispatch(createEvent('start', {}, { scope }))
    expect(await engine.dispatch(createEvent('ci', {}, { scope }))).toBe('resumed')
    const resumed = byName('event ci')
    expect(resumed.attributes['ia.dispatch.outcome']).toBe('resumed')
    expect(
      resumed.events.filter((e) => e.name === 'execution.resume').map((e) => e.attributes),
    ).toEqual([{ 'ia.execution.id': 'exec-1', 'ia.pause.branch': 'green' }])
    const bodies = logRecords.getFinishedLogRecords().map((record) => String(record.body))
    expect(bodies).toContain('exec-1 se pausa en "wait" (green: ci)')
    expect(bodies).toContain('evento "ci" reanuda exec-1 por "green"')

    await engine.dispatch(createEvent('start', {}, { scope }))
    engine.tick(Date.now() + 5_000)
    await vi.waitFor(() => byName('execution.expired'))
    const expired = byName('execution.expired')
    expect(parentOf(expired)).toBeUndefined()
    expect(expired.attributes).toMatchObject({
      'ia.execution.id': 'exec-2',
      'ia.dispatch.outcome': 'resumed',
    })
  })
})
