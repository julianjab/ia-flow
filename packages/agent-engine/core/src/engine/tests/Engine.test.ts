import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry } from '../../agent/Provider.js'
import { Condition } from '../../condition/Condition.js'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { EmitAction } from '../../pipeline/actions/EmitAction.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { DEFAULT_MAX_EVENT_DEPTH, Engine } from '../Engine.js'
import { StaticPipelineSource } from '../PipelineSource.js'

describe('Engine.dispatch', () => {
  it('returns "skipped" when no pipeline matches the event type', async () => {
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([new Pipeline({ id: 'p', on: ['other'], do: [] })]),
    })
    expect(await engine.dispatch(createEvent('a', {}))).toBe('skipped')
  })

  it('returns "skipped" once the event is at or past maxEventDepth', async () => {
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([new Pipeline({ id: 'p', on: ['a'], do: [] })]),
      maxEventDepth: 2,
    })
    expect(await engine.dispatch(createEvent('a', {}, { depth: 2 }))).toBe('skipped')
  })

  it('defaults maxEventDepth to DEFAULT_MAX_EVENT_DEPTH', async () => {
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([new Pipeline({ id: 'p', on: ['a'], do: [] })]),
    })
    expect(await engine.dispatch(createEvent('a', {}, { depth: DEFAULT_MAX_EVENT_DEPTH }))).toBe(
      'skipped',
    )
  })

  it('dispatches a matching pipeline and chains steps through ctx.steps', async () => {
    const registry = new ProviderRegistry()
      .register({
        id: 'triage-provider',
        run: async (ctx) => ({ outcome: 'success', summary: String(ctx.prompt.includes('bug')) }),
      })
      .register({
        id: 'fix-provider',
        run: async () => ({ outcome: 'success', summary: 'patched' }),
      })

    const seen: unknown[] = []
    const pipeline = new Pipeline({
      id: 'github-triage',
      on: ['github.issue.opened'],
      do: [
        new Agent(
          {
            id: 'triage',
            provider: 'triage-provider',
            prompt: '{{title}}',
          },
          registry,
        ),
        new Agent(
          {
            id: 'fix',
            provider: 'fix-provider',
            prompt: 'fix it',
            when: Condition.fromRows([
              { field: 'steps.triage.output.summary', op: 'eq', value: 'true' },
            ]),
          },
          registry,
        ),
        new FunctionAction({ fn: (ctx) => seen.push(ctx.steps.fix) }),
      ],
    })

    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([pipeline]),
    })
    const outcome = await engine.dispatch(createEvent('github.issue.opened', { title: 'fix bug' }))

    expect(outcome).toBe('dispatched')
    expect(seen).toEqual([
      {
        output: { outcome: 'success', summary: 'patched' },
        exit: 'done',
        payload: {},
        provider: 'fix-provider',
      },
    ])
  })

  it('skips a step whose when does not match, and does not run its agent', async () => {
    let ran = false
    const registry = new ProviderRegistry().register({
      id: 'fix-provider',
      run: async () => {
        ran = true
        return { outcome: 'success', summary: 'patched' }
      },
    })

    const pipeline = new Pipeline({
      id: 'github-triage',
      on: ['github.issue.opened'],
      do: [
        new Agent(
          {
            id: 'fix',
            provider: 'fix-provider',
            prompt: 'fix it',
            when: Condition.fromRows([{ field: 'actionable', op: 'eq', value: true }]),
          },
          registry,
        ),
      ],
    })

    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([pipeline]),
    })
    await engine.dispatch(createEvent('github.issue.opened', { actionable: false }))

    expect(ran).toBe(false)
  })

  it('runs all matching non-exclusive pipelines in parallel', async () => {
    const ranPipelines: string[] = []
    const p1 = new Pipeline({
      id: 'p1',
      on: ['a'],
      do: [new FunctionAction({ fn: () => ranPipelines.push('p1') })],
    })
    const p2 = new Pipeline({
      id: 'p2',
      on: ['a'],
      do: [new FunctionAction({ fn: () => ranPipelines.push('p2') })],
    })

    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([p1, p2]),
    })
    await engine.dispatch(createEvent('a', {}))

    expect(ranPipelines.sort()).toEqual(['p1', 'p2'])
  })

  it('the winning exclusive pipeline (lowest position) suppresses exclusive AND non-exclusive matches of equal-or-lower priority', async () => {
    const ranPipelines: string[] = []
    const low = new Pipeline({
      id: 'low',
      on: ['x'],
      exclusive: true,
      position: 10,
      do: [new FunctionAction({ fn: () => ranPipelines.push('low') })],
    })
    const high = new Pipeline({
      id: 'high',
      on: ['x'],
      exclusive: true,
      position: 5,
      do: [new FunctionAction({ fn: () => ranPipelines.push('high') })],
    })
    const nonExclusiveLowerPriority = new Pipeline({
      id: 'non-exclusive-lower',
      on: ['x'],
      position: 5,
      do: [new FunctionAction({ fn: () => ranPipelines.push('non-exclusive-lower') })],
    })

    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([low, high, nonExclusiveLowerPriority]),
    })
    await engine.dispatch(createEvent('x', {}))

    expect(ranPipelines).toEqual(['high'])
  })

  it('a pipeline with HIGHER priority (lower position) than the winning exclusive still runs alongside it', async () => {
    const ranPipelines: string[] = []
    const exclusive = new Pipeline({
      id: 'exclusive',
      on: ['x'],
      exclusive: true,
      position: 5,
      do: [new FunctionAction({ fn: () => ranPipelines.push('exclusive') })],
    })
    const higherPriority = new Pipeline({
      id: 'higher-priority',
      on: ['x'],
      position: 0,
      do: [new FunctionAction({ fn: () => ranPipelines.push('higher-priority') })],
    })

    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([exclusive, higherPriority]),
    })
    await engine.dispatch(createEvent('x', {}))

    expect(ranPipelines.sort()).toEqual(['exclusive', 'higher-priority'])
  })

  it('start() subscribes to the bus so a plain publish triggers a dispatch', async () => {
    const bus = new EventBus()
    let ran = false
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      do: [
        new FunctionAction({
          fn: () => {
            ran = true
          },
        }),
      ],
    })
    const engine = new Engine({
      bus,
      pipelines: new StaticPipelineSource([pipeline]),
    })

    const stop = engine.start()
    await bus.publish(createEvent('a', {}))
    stop()

    expect(ran).toBe(true)
  })

  it('stops a self-emitting pipeline once maxEventDepth is hit', async () => {
    const bus = new EventBus()
    let pingCount = 0
    bus.subscribe('ping', () => {
      pingCount++
    })

    // Un pipeline que se re-emite a sí mismo (EmitAction 'ping' sobre on: ['ping']) es
    // exactamente el ciclo sin fondo que maxEventDepth existe para cortar.
    const pipeline = new Pipeline({
      id: 'loop',
      on: ['ping'],
      do: [new EmitAction({ type: 'ping' })],
    })
    const engine = new Engine({
      bus,
      pipelines: new StaticPipelineSource([pipeline]),
      maxEventDepth: 3,
    })
    const stop = engine.start()

    await bus.publish(createEvent('ping', {}))
    await new Promise((resolve) => setTimeout(resolve, 20))
    stop()

    // depth 0 (inicial) + 3 derivados (depth 1,2,3) llegan a publish; el dispatch en
    // depth 3 ve `depth >= maxEventDepth` y no deriva un cuarto — la cadena no es infinita.
    expect(pingCount).toBe(4)
  })

  it('start() returns the dispatch promise to the bus, so a pipeline error surfaces via publish() instead of an unhandled rejection', async () => {
    const bus = new EventBus()
    const pipeline = new Pipeline({
      id: 'boom',
      on: ['a'],
      do: [
        new FunctionAction({
          fn: () => {
            throw new Error('agent exploded')
          },
        }),
      ],
    })
    const engine = new Engine({
      bus,
      pipelines: new StaticPipelineSource([pipeline]),
    })

    const stop = engine.start()
    await expect(bus.publish(createEvent('a', {}))).rejects.toThrow(AggregateError)
    stop()
  })

  it('a failing pipeline does not stop sibling pipelines from running, and ALL failures surface', async () => {
    const ranPipelines: string[] = []
    const failFast = new Pipeline({
      id: 'fail-fast',
      on: ['a'],
      do: [
        new FunctionAction({
          fn: () => {
            throw new Error('fail-fast boom')
          },
        }),
      ],
    })
    const slowThenFails = new Pipeline({
      id: 'slow-then-fails',
      on: ['a'],
      do: [
        new FunctionAction({
          fn: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10))
            throw new Error('slow boom')
          },
        }),
      ],
    })
    const succeeds = new Pipeline({
      id: 'succeeds',
      on: ['a'],
      do: [new FunctionAction({ fn: () => ranPipelines.push('succeeds') })],
    })

    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([failFast, slowThenFails, succeeds]),
    })

    let thrown: unknown
    try {
      await engine.dispatch(createEvent('a', {}))
    } catch (err) {
      thrown = err
    }

    // El pipeline que no falla corrió igual — un fallo en otro no lo cortó a mitad de camino.
    expect(ranPipelines).toEqual(['succeeds'])
    // Y el error agregado trae LOS DOS fallos, no sólo el primero que ganó la carrera.
    expect(thrown).toBeInstanceOf(AggregateError)
    const messages = (thrown as AggregateError).errors.map((e: Error) => e.message).sort()
    expect(messages).toEqual(['fail-fast boom', 'slow boom'])
  })

  it('start() returns an unsubscribe that stops future dispatches', async () => {
    const bus = new EventBus()
    let calls = 0
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      do: [
        new FunctionAction({
          fn: () => {
            calls++
          },
        }),
      ],
    })
    const engine = new Engine({
      bus,
      pipelines: new StaticPipelineSource([pipeline]),
    })

    const stop = engine.start()
    stop()
    await bus.publish(createEvent('a', {}))

    expect(calls).toBe(0)
  })
})
