import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry } from '../../agent/Provider.js'
import { Condition } from '../../condition/Condition.js'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { END } from '../../routing/ExitRoutes.js'
import { Action } from '../actions/Action.js'
import { FunctionAction } from '../actions/FunctionAction.js'
import { isAgent, Pipeline } from '../Pipeline.js'
import type { PipelineExecutionContext } from '../Runnable.js'

function fakeRegistry(outcome = 'success', summary = 'a-out') {
  return new ProviderRegistry().register({
    id: 'fake',
    run: async () => ({ outcome, summary }),
  })
}

describe('Pipeline.matches', () => {
  it('requires enabled', () => {
    const pipeline = new Pipeline({ id: 'p', on: ['a'], enabled: false, do: [] })
    expect(pipeline.matches(createEvent('a', {}))).toBe(false)
  })

  it('requires the event type to be in `on`', () => {
    const pipeline = new Pipeline({ id: 'p', on: ['a'], do: [] })
    expect(pipeline.matches(createEvent('b', {}))).toBe(false)
    expect(pipeline.matches(createEvent('a', {}))).toBe(true)
  })

  it('narrows by scope — every declared key must match exactly', () => {
    const pipeline = new Pipeline({ id: 'p', on: ['a'], scope: { channel: 'C1' }, do: [] })
    expect(pipeline.matches(createEvent('a', {}, { scope: { channel: 'C1' } }))).toBe(true)
    expect(pipeline.matches(createEvent('a', {}, { scope: { channel: 'C2' } }))).toBe(false)
    expect(pipeline.matches(createEvent('a', {}))).toBe(false)
  })

  it('with no scope declared, any event scope matches', () => {
    const pipeline = new Pipeline({ id: 'p', on: ['a'], do: [] })
    expect(pipeline.matches(createEvent('a', {}, { scope: { channel: 'C1' } }))).toBe(true)
  })

  it('evaluates `when` against the event payload', () => {
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      when: Condition.fromRows([{ field: 'urgent', op: 'eq', value: true }]),
      do: [],
    })
    expect(pipeline.matches(createEvent('a', { urgent: true }))).toBe(true)
    expect(pipeline.matches(createEvent('a', { urgent: false }))).toBe(false)
  })
})

describe('Pipeline.execute', () => {
  function ctxFor(pipeline: Pipeline, payload: Record<string, unknown> = {}) {
    return {
      event: createEvent('a', payload),
      steps: {},
      bus: new EventBus(),
      pipelineId: pipeline.id,
    }
  }

  it('accumulates named step outputs into ctx.steps', async () => {
    const registry = fakeRegistry()
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      do: [
        new Agent({ id: 'first', provider: 'fake', prompt: 'p' }, registry),
        new FunctionAction({ id: 'second', fn: (ctx) => ctx.steps.first }),
      ],
    })

    const steps = await pipeline.execute(ctxFor(pipeline))

    expect(steps.first).toEqual({
      output: { outcome: 'success', summary: 'a-out' },
      exit: 'done',
      payload: {},
    })
    expect(steps.second).toEqual(steps.first)
  })

  it('sets ctx.pipelineId to its own id, overriding whatever was passed in', async () => {
    const pipeline = new Pipeline({
      id: 'real-id',
      on: ['a'],
      do: [new FunctionAction({ id: 'capture', fn: (ctx) => ctx.pipelineId })],
    })
    const steps = await pipeline.execute(ctxFor(pipeline))
    expect(steps.capture).toBe('real-id')
  })

  it('skips a step without recording it in ctx.steps', async () => {
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      do: [
        new FunctionAction({
          id: 'skipped',
          when: Condition.fromRows([{ field: 'go', op: 'eq', value: true }]),
          fn: () => 'should-not-run',
        }),
      ],
    })
    const steps = await pipeline.execute(ctxFor(pipeline, { go: false }))
    expect(steps.skipped).toBeUndefined()
  })

  it('an unnamed step (no id) runs but leaves no trace in ctx.steps', async () => {
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
    const steps = await pipeline.execute(ctxFor(pipeline))
    expect(ran).toBe(true)
    expect(Object.keys(steps)).toHaveLength(0)
  })

  it('a throwing step aborts the pipeline by default', async () => {
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      do: [
        new FunctionAction({
          id: 'boom',
          fn: () => {
            throw new Error('kaboom')
          },
        }),
        new FunctionAction({ id: 'never', fn: () => 'unreachable' }),
      ],
    })
    await expect(pipeline.execute(ctxFor(pipeline))).rejects.toThrow('kaboom')
  })

  it('continueOnError lets the pipeline proceed past a throwing step', async () => {
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      do: [
        new FunctionAction({
          id: 'boom',
          continueOnError: true,
          fn: () => {
            throw new Error('kaboom')
          },
        }),
        new FunctionAction({ id: 'after', fn: () => 'still-runs' }),
      ],
    })
    const steps = await pipeline.execute(ctxFor(pipeline))
    expect(steps.boom).toBeUndefined()
    expect(steps.after).toBe('still-runs')
  })
})

describe('isAgent', () => {
  it('narrows a Runnable to Agent', () => {
    const agent = new Agent({ id: 'x', provider: 'fake', prompt: 'p' }, fakeRegistry())
    const functionAction = new FunctionAction({ fn: () => undefined })
    expect(isAgent(agent)).toBe(true)
    expect(isAgent(functionAction)).toBe(false)
  })
})

// --- Rutas ---------------------------------------------------------------------------------

/** Qué hace el "modelo" de cada agente: llamar un submit con un payload, o fallar. */
type Script = Record<string, { submit: string; payload?: unknown } | { fail: string }>

function scriptedRegistry(script: Script, prompts: Record<string, string> = {}) {
  return new ProviderRegistry().register({
    id: 'fake',
    run: async (ctx) => {
      prompts[ctx.agentId] = ctx.prompt
      const step = script[ctx.agentId]
      if (!step) return { outcome: 'success' }
      if ('fail' in step) throw new Error(step.fail)
      await ctx.tools.find((tool) => tool.name === step.submit)?.handler(step.payload ?? {})
      return { outcome: 'success' }
    },
  })
}

/** Una acción que anota en `log` cada vez que corre, con su input. */
function recorder(id: string, log: string[], input = z.strictObject({})) {
  return new (class extends Action<typeof input> {
    readonly description = id
    readonly input = input
    execute(value: unknown) {
      log.push(`${id}${Object.keys(value as object).length ? ` ${JSON.stringify(value)}` : ''}`)
      return id
    }
  })({ id })
}

function ctx(): PipelineExecutionContext {
  return { event: createEvent('e', {}), steps: {}, bus: new EventBus(), pipelineId: '' }
}

describe('Pipeline routes', () => {
  it('runs the report first, then the chosen exit destinations in order', async () => {
    const log: string[] = []
    const report = recorder('report', log, z.strictObject({ summary: z.string() }))
    const toBuild = recorder('to_build', log)
    const notify = recorder('notify', log)
    const other = recorder('other', log)
    const reviewer = new Agent(
      {
        id: 'reviewer',
        provider: 'fake',
        prompt: 'p',
        report,
        routes: { back_to_build: { to: [toBuild, notify] }, approved: { to: other } },
      },
      scriptedRegistry({
        reviewer: { submit: 'submit_back_to_build', payload: { report: { summary: 'falla X' } } },
      }),
    )

    await new Pipeline({ id: 'p', on: ['e'], do: [reviewer] }).execute(ctx())

    expect(log).toEqual(['report {"summary":"falla X"}', 'to_build', 'notify'])
  })

  it('a step reachable through a route does not run on its own in do[]', async () => {
    const log: string[] = []
    const notify = recorder('notify', log)
    const triage = new Agent(
      {
        id: 'triage',
        provider: 'fake',
        prompt: 'p',
        routes: { actionable: { to: notify }, not_actionable: { to: END } },
      },
      scriptedRegistry({ triage: { submit: 'submit_not_actionable' } }),
    )

    await new Pipeline({ id: 'p', on: ['e'], do: [triage, notify] }).execute(ctx())

    expect(log).toEqual([])
  })

  it('chains agents: the model output of one is the typed input of the next', async () => {
    const prompts: Record<string, string> = {}
    const registry = scriptedRegistry(
      { triage: { submit: 'submit_actionable', payload: { refiner: { summary: 'paginar' } } } },
      prompts,
    )
    const triage = new Agent(
      {
        id: 'triage',
        provider: 'fake',
        prompt: 'p',
        routes: { actionable: { when: 'Pide un cambio' }, not_actionable: { to: END } },
      },
      registry,
    )
    const refiner = new Agent(
      {
        id: 'refiner',
        provider: 'fake',
        prompt: 'Ajustá: {{input.summary}}',
        input: z.strictObject({ summary: z.string().optional() }),
      },
      registry,
    )

    const steps = await new Pipeline({
      id: 'comment-refine',
      on: ['e'],
      do: [triage, refiner],
      routes: { triage: { routes: { actionable: { to: refiner } } } },
    }).execute(ctx())

    expect(prompts.refiner).toBe('Ajustá: paginar')
    expect(steps.refiner).toMatchObject({ exit: 'done' })
  })

  it('onError runs the error report and destinations instead of failing the pipeline', async () => {
    const log: string[] = []
    const report = recorder('report', log, z.strictObject({ summary: z.string() }))
    const blocked = recorder('blocked', log)
    const implementer = new Agent(
      { id: 'implementer', provider: 'fake', prompt: 'p', report },
      scriptedRegistry({ implementer: { fail: 'sin acceso al repo' } }),
    )

    const steps = await new Pipeline({
      id: 'p',
      on: ['e'],
      do: [implementer],
      onError: { to: blocked, report: (err) => ({ summary: `Falló: ${err.message}` }) },
    }).execute(ctx())

    expect(log).toEqual(['report {"summary":"Falló: sin acceso al repo"}', 'blocked'])
    expect(steps.implementer).toEqual({ error: 'sin acceso al repo' })
  })

  it('the project onError applies when neither the agent nor the pipeline defines one', async () => {
    const log: string[] = []
    const blocked = recorder('blocked', log)
    const implementer = new Agent(
      { id: 'implementer', provider: 'fake', prompt: 'p' },
      scriptedRegistry({ implementer: { fail: 'boom' } }),
    )

    await new Pipeline({ id: 'p', on: ['e'], do: [implementer] }).execute({
      ...ctx(),
      defaults: { onError: { to: blocked } },
    })

    expect(log).toEqual(['blocked'])
  })

  it('without onError anywhere, an agent failure still aborts the pipeline', async () => {
    const implementer = new Agent(
      { id: 'implementer', provider: 'fake', prompt: 'p' },
      scriptedRegistry({ implementer: { fail: 'boom' } }),
    )

    await expect(
      new Pipeline({ id: 'p', on: ['e'], do: [implementer] }).execute(ctx()),
    ).rejects.toThrow('boom')
  })

  describe('validation at construction', () => {
    const registry = scriptedRegistry({})

    it('rejects a vocabulary-only exit the pipeline did not give a destination', () => {
      const triage = new Agent(
        { id: 'triage', provider: 'fake', prompt: 'p', routes: { actionable: { when: 'x' } } },
        registry,
      )

      expect(() => new Pipeline({ id: 'p', on: ['e'], do: [triage] })).toThrow(
        /"actionable" no tiene destino/,
      )
    })

    it('rejects overrides for an agent the pipeline does not run', () => {
      expect(
        () =>
          new Pipeline({
            id: 'p',
            on: ['e'],
            do: [],
            routes: { ghost: { routes: {} } },
          }),
      ).toThrow(/routes.ghost sobrescribe un agente que la pipeline no corre/)
    })

    it('rejects a cycle between agents', () => {
      const a = new Agent(
        { id: 'a', provider: 'fake', prompt: 'p', routes: { next: {} } },
        registry,
      )
      const b = new Agent(
        { id: 'b', provider: 'fake', prompt: 'p', routes: { next: {} } },
        registry,
      )

      expect(
        () =>
          new Pipeline({
            id: 'p',
            on: ['e'],
            do: [a],
            routes: { a: { routes: { next: { to: b } } }, b: { routes: { next: { to: a } } } },
          }),
      ).toThrow(/ciclo entre agentes \(a → b → a\)/)
    })

    it('rejects two different agents with the same id', () => {
      const one = new Agent({ id: 'x', provider: 'fake', prompt: 'p' }, registry)
      const two = new Agent({ id: 'x', provider: 'fake', prompt: 'p' }, registry)

      expect(() => new Pipeline({ id: 'p', on: ['e'], do: [one, two] })).toThrow(
        /dos agentes distintos con el id "x"/,
      )
    })
  })

  it('routesOf shows the effective routes with their origin', () => {
    const blocked = new FunctionAction({ id: 'blocked', fn: () => null })
    const refiner = new Agent(
      {
        id: 'refiner',
        provider: 'fake',
        prompt: 'p',
        routes: { done: { to: END }, back_to_build: { to: END } },
      },
      scriptedRegistry({}),
    )
    const pipeline = new Pipeline({
      id: 'p',
      on: ['e'],
      do: [refiner],
      routes: { refiner: { routes: { back_to_build: null } } },
    })

    const routes = pipeline.routesOf('refiner', { onError: { to: blocked } })

    expect(routes.exits.map((exit) => [exit.name, exit.origin])).toEqual([['done', 'agent']])
    expect(routes.onError?.origin).toBe('project')
    expect(() => pipeline.routesOf('nope')).toThrow(/no corre ningún agente "nope"/)
  })
})

describe('Pipeline onError on any step', () => {
  const failing = (id: string, message = 'boom') =>
    new FunctionAction({
      id,
      fn: () => {
        throw new Error(message)
      },
    })

  it('a step onError handles its own failure and records the error', async () => {
    const log: string[] = []
    const alert = recorder('alert', log)
    const after = new FunctionAction({ id: 'after', fn: () => 'sigue' })

    const steps = await new Pipeline({
      id: 'p',
      on: ['e'],
      do: [
        new FunctionAction({
          id: 'notify',
          fn: () => {
            throw new Error('slack caído')
          },
          onError: { to: alert },
        }),
        after,
      ],
    }).execute(ctx())

    expect(log).toEqual(['alert'])
    expect(steps.notify).toEqual({ error: 'slack caído' })
    expect(steps.after).toBe('sigue')
  })

  it('the pipeline onError applies to any failing step, with its report', async () => {
    const log: string[] = []
    const report = recorder('report', log, z.strictObject({ summary: z.string() }))

    await new Pipeline({
      id: 'p',
      on: ['e'],
      do: [failing('http')],
      report,
      onError: { to: recorder('blocked', log), report: (err) => ({ summary: err.message }) },
    }).execute(ctx())

    expect(log).toEqual(['report {"summary":"boom"}', 'blocked'])
  })

  it('the project onError applies when neither the step nor the pipeline defines one', async () => {
    const log: string[] = []

    await new Pipeline({ id: 'p', on: ['e'], do: [failing('http')] }).execute({
      ...ctx(),
      defaults: { onError: { to: recorder('blocked', log) } },
    })

    expect(log).toEqual(['blocked'])
  })

  it('a step onError of null opts out of the pipeline onError', async () => {
    const log: string[] = []
    const step = new FunctionAction({
      id: 'x',
      fn: () => {
        throw new Error('boom')
      },
      onError: null,
    })

    await expect(
      new Pipeline({
        id: 'p',
        on: ['e'],
        do: [step],
        onError: { to: recorder('blocked', log) },
      }).execute(ctx()),
    ).rejects.toThrow('boom')
    expect(log).toEqual([])
  })

  it('continueOnError still works as the last resort when no onError handles it', async () => {
    const steps = await new Pipeline({
      id: 'p',
      on: ['e'],
      do: [
        new FunctionAction({
          id: 'x',
          fn: () => {
            throw new Error('boom')
          },
          continueOnError: true,
        }),
        new FunctionAction({ id: 'after', fn: () => 'sigue' }),
      ],
    }).execute(ctx())

    expect(steps.after).toBe('sigue')
  })

  it('a failure inside an error route propagates instead of re-entering onError', async () => {
    const blocked = failing('blocked', 'sin permisos para la label')

    await expect(
      new Pipeline({
        id: 'p',
        on: ['e'],
        do: [failing('http')],
        onError: { to: blocked },
      }).execute(ctx()),
    ).rejects.toThrow('sin permisos para la label')
  })

  it('an error route target listed in do[] does not also run on its own', async () => {
    const log: string[] = []
    const blocked = recorder('blocked', log)

    await new Pipeline({
      id: 'p',
      on: ['e'],
      do: [new FunctionAction({ id: 'ok', fn: () => null }), blocked],
      onError: { to: blocked },
    }).execute(ctx())

    expect(log).toEqual([])
  })
})
