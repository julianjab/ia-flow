import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry } from '../../agent/Provider.js'
import { Condition } from '../../condition/Condition.js'
import { createEvent, type DomainEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { PauseAction } from '../../pipeline/actions/PauseAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { Engine, scopeExecutionKey } from '../Engine.js'
import { InMemoryExecutionStore } from '../InMemoryExecutionStore.js'
import { StaticPipelineSource } from '../PipelineSource.js'

const TASK = { projectId: 'p', issue: 7 }
const event = (type: string, payload: Record<string, unknown> = {}): DomainEvent =>
  createEvent(type, payload, { scope: TASK })
const ci = (conclusion: string) => event('check_suite', { conclusion })
const KEY = scopeExecutionKey(event('x')) as string

/** Un agente que elige `done` siempre. */
function implementer(ran: string[]) {
  return (routes: Record<string, unknown>) =>
    new Agent(
      { id: 'implementer', provider: 'done', prompt: 'p', routes: routes as never },
      new ProviderRegistry().register({
        id: 'done',
        run: async (ctx) => {
          ran.push(`implementer:${ctx.ctx.event.type}`)
          await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
          return { outcome: 'success' }
        },
      }),
    )
}

const action = (id: string, ran: string[]) =>
  new FunctionAction({ id, fn: (ctx) => ran.push(`${id}:${ctx.event.type}`) })

/** El gate de CI: el implementer termina, se asegura el PR y espera el CI. Verde → Review. */
function ciGate(options: { timeoutMs?: number; maxConcurrent?: number; extra?: Pipeline[] } = {}) {
  const ran: string[] = []
  const review = action('review', ran)
  const expiredNote = action('expired-note', ran)
  const waitCi = new PauseAction({
    id: 'wait-ci',
    branches: {
      green: {
        on: ['check_suite'],
        when: [new Condition({ field: 'conclusion', op: 'eq', value: 'success' })],
        to: review,
      },
    },
    ...(options.timeoutMs ? { timeout: { afterMs: options.timeoutMs, to: expiredNote } } : {}),
  })
  const build = new Pipeline({
    id: 'build',
    on: ['build'],
    do: [implementer(ran)({ done: { to: [action('ensure-pr', ran), waitCi] } })],
  })
  // CI rojo no es una rama de la pausa: lo levanta su propia regla, que la reemplaza.
  const ciRed = new Pipeline({
    id: 'ci-red',
    on: ['check_suite'],
    when: [new Condition({ field: 'conclusion', op: 'eq', value: 'failure' })],
    do: [implementer(ran)({ done: { to: action('pushed', ran) } })],
  })
  const store = new InMemoryExecutionStore(
    options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {},
  )
  // Una fuente que se puede romper a mitad del test (`broken.now = true`).
  const broken = { now: false }
  const pipelines = [build, ciRed, ...(options.extra ?? [])]
  const engine = new Engine({
    bus: new EventBus(),
    pipelines: {
      list: () => {
        if (broken.now) throw new Error('no pude leer el roster')
        return pipelines
      },
    },
    executions: store,
  })
  return { engine, store, ran, broken }
}

describe('Engine with pauses', () => {
  it('pauses where the PauseAction is, frees the task and keeps the execution waiting', async () => {
    const { engine, store, ran } = ciGate()
    expect(await engine.dispatch(event('build'))).toBe('dispatched')

    expect(ran).toEqual(['implementer:build', 'ensure-pr:build'])
    const paused = store.current(KEY)
    expect(paused?.status).toBe('paused')
    expect(paused?.pausedOn?.pauseId).toBe('wait-ci')
    // Una pausa no ocupa la task ni un lugar bajo el tope.
    expect(store.busy(KEY)).toBe(false)
    expect(store.stats).toEqual({ running: 0, waiting: 0, paused: 1 })
  })

  it('an event that matches a branch resumes it: runs the branch and closes', async () => {
    const { engine, store, ran } = ciGate()
    await engine.dispatch(event('build'))
    const execution = store.current(KEY)

    expect(await engine.dispatch(ci('success'))).toBe('resumed')
    expect(ran).toEqual(['implementer:build', 'ensure-pr:build', 'review:check_suite'])
    expect(execution?.status).toBe('done')
    expect(store.current(KEY)).toBeUndefined()
  })

  it('an event that matches no branch goes through the rules; a new run supersedes the pause', async () => {
    const { engine, store, ran } = ciGate()
    await engine.dispatch(event('build'))
    const paused = store.current(KEY)

    expect(await engine.dispatch(ci('failure'))).toBe('dispatched')
    expect(paused?.status).toBe('superseded')
    expect(ran).toEqual([
      'implementer:build',
      'ensure-pr:build',
      'implementer:check_suite',
      'pushed:check_suite',
    ])
    // Ya no hay nada que el verde pueda reanudar.
    expect(await engine.dispatch(ci('success'))).toBe('skipped')
  })

  it('a pause resumes once: a second matching event finds nothing to wake', async () => {
    const { engine, ran } = ciGate()
    await engine.dispatch(event('build'))
    const [first, second] = await Promise.all([
      engine.dispatch(ci('success')),
      engine.dispatch(ci('success')),
    ])
    expect([first, second].sort()).toEqual(['resumed', 'skipped'])
    expect(ran.filter((step) => step.startsWith('review'))).toHaveLength(1)
  })

  it('an injected event nobody read wakes the pause it was waiting for', async () => {
    const ran: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const running = new Promise<void>((resolve) => {
      entered = resolve
    })
    const worker = new Agent(
      {
        id: 'worker',
        provider: 'held',
        prompt: 'p',
        injects: [{ on: ['comment'] }],
        routes: {
          done: {
            to: new PauseAction({
              id: 'wait-answer',
              branches: { answered: { on: ['comment'], to: action('answered', ran) } },
            }),
          },
        },
      },
      new ProviderRegistry().register({
        id: 'held',
        // Nunca vacía su inbox: el comentario queda sin leer.
        run: async (ctx) => {
          entered()
          await gate
          await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
          return { outcome: 'success' }
        },
      }),
    )
    const store = new InMemoryExecutionStore()
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([new Pipeline({ id: 'ask', on: ['ask'], do: [worker] })]),
      executions: store,
    })

    const ask = engine.dispatch(event('ask'))
    await running
    expect(await engine.dispatch(event('comment'))).toBe('injected')
    release()
    await ask

    await vi.waitFor(() => expect(ran).toEqual(['answered:comment']))
    await vi.waitFor(() => expect(store.current(KEY)).toBeUndefined())
  })

  it('an event that arrives before the pause exists still wakes it once it pauses', async () => {
    const ran: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const running = new Promise<void>((resolve) => {
      entered = resolve
    })
    const implementer = new Agent(
      {
        id: 'implementer',
        provider: 'held',
        prompt: 'p',
        routes: {
          done: {
            to: new PauseAction({
              id: 'wait-ci',
              branches: {
                green: {
                  on: ['check_suite'],
                  when: [new Condition({ field: 'conclusion', op: 'eq', value: 'success' })],
                  to: action('review', ran),
                },
              },
            }),
          },
        },
      },
      new ProviderRegistry().register({
        id: 'held',
        run: async (ctx) => {
          entered()
          await gate
          await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
          return { outcome: 'success' }
        },
      }),
    )
    const store = new InMemoryExecutionStore()
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([
        new Pipeline({ id: 'build', on: ['build'], do: [implementer] }),
      ]),
      executions: store,
    })

    const build = engine.dispatch(event('build'))
    await running
    // El CI termina antes de que el implementer elija su salida: todavía no hay pausa.
    expect(await engine.dispatch(ci('success'))).toBe('skipped')
    release()
    await build

    await vi.waitFor(() => expect(ran).toEqual(['review:check_suite']))
    await vi.waitFor(() => expect(store.current(KEY)).toBeUndefined())
  })

  it('an event that wakes the pause late does not also run the rules once its dispatch resumes', async () => {
    const ran: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const running = new Promise<void>((resolve) => {
      entered = resolve
    })
    const green = new Condition({ field: 'conclusion', op: 'eq', value: 'success' })
    const implementer = new Agent(
      {
        id: 'implementer',
        provider: 'held',
        prompt: 'p',
        routes: {
          done: {
            to: new PauseAction({
              id: 'wait-ci',
              branches: {
                green: { on: ['check_suite'], when: [green], to: action('review', ran) },
              },
            }),
          },
        },
      },
      new ProviderRegistry().register({
        id: 'held',
        run: async (ctx) => {
          entered()
          await gate
          await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
          return { outcome: 'success' }
        },
      }),
    )
    // Una regla con agentes que TAMBIÉN escucha el verde: no tiene que correr si la pausa lo usó.
    const alsoGreen = new Pipeline({
      id: 'also-green',
      on: ['check_suite'],
      when: [green],
      do: [
        new Agent(
          { id: 'other', provider: 'noop', prompt: 'p' },
          new ProviderRegistry().register({
            id: 'noop',
            run: async () => {
              ran.push('other')
              return { outcome: 'success' }
            },
          }),
        ),
      ],
    })
    // Leer las reglas cede el turno de verdad (y se puede frenar).
    let slow: Promise<void> | undefined
    let unblock!: () => void
    const pipelines = [new Pipeline({ id: 'build', on: ['build'], do: [implementer] }), alsoGreen]
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: {
        list: async () => {
          await slow
          return pipelines
        },
      },
      executions: new InMemoryExecutionStore(),
    })

    const build = engine.dispatch(event('build'))
    await running
    slow = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const green1 = engine.dispatch(ci('success'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Mientras ese despacho lee las reglas, el implementer termina y se pausa: la pausa lo usa.
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    unblock()
    slow = undefined
    await Promise.all([build, green1])

    await vi.waitFor(() => expect(ran).toEqual(['review:check_suite']))
    expect(await green1).toBe('resumed')
  })

  it('if the rules cannot be read, the pause is not woken and the task stays free', async () => {
    const { engine, store, broken } = ciGate()
    await engine.dispatch(event('build'))
    broken.now = true

    await expect(engine.dispatch(ci('success'))).rejects.toThrow('no pude leer el roster')
    expect(store.current(KEY)?.status).toBe('paused')
    expect(store.busy(KEY)).toBe(false)

    broken.now = false
    expect(await engine.dispatch(ci('success'))).toBe('resumed')
  })

  it('a pause is not woken while a run for its task is queued: that run supersedes it', async () => {
    // Otra task ocupa el único lugar; el `ci-red` de ESTA task queda en cola.
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const holding = new Promise<void>((resolve) => {
      started = resolve
    })
    const blocker = new Pipeline({
      id: 'blocker',
      on: ['other'],
      do: [
        new Agent(
          { id: 'other', provider: 'held', prompt: 'p' },
          new ProviderRegistry().register({
            id: 'held',
            run: async () => {
              started()
              await held
              return { outcome: 'success' }
            },
          }),
        ),
      ],
    })
    const { engine, store, ran } = ciGate({ maxConcurrent: 1, extra: [blocker] })
    await engine.dispatch(event('build'))
    const paused = store.current(KEY)

    const other = engine.dispatch(createEvent('other', {}, { scope: { issue: 'otra' } }))
    await holding
    const red = engine.dispatch(ci('failure'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.busy(KEY)).toBe(true)

    // El verde llega con el `ci-red` en cola: no la despierta.
    expect(await engine.dispatch(ci('success'))).toBe('skipped')
    engine.tick(Date.now() + 10 * 60 * 60_000)
    release()
    await Promise.all([other, red])

    expect(paused?.status).toBe('superseded')
    expect(ran).not.toContain('review:check_suite')
    expect(ran.at(-1)).toBe('pushed:check_suite')
  })

  describe('ifPaused: wait — a rule that must not replace the pause', () => {
    /** Un triage de comentarios que no trae trabajo nuevo: no puede llevarse puesta la espera del
     *  CI (el caso de subscriptions#1625: `not_actionable` y la tarjeta nunca pasó a Review). */
    const triage = (ran: string[]) =>
      new Pipeline({
        id: 'comment',
        on: ['comment'],
        ifPaused: 'wait',
        do: [implementer(ran)({ done: { to: action('triaged', ran) } })],
      })

    it('does not supersede the pause: it runs once the pause wakes and closes', async () => {
      const ran: string[] = []
      const { engine, store } = ciGate({ extra: [triage(ran)] })
      await engine.dispatch(event('build'))
      const paused = store.current(KEY)

      const comment = engine.dispatch(event('comment'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(paused?.status).toBe('paused')
      // Mientras espera no ocupa la task: la pausa puede despertar.
      expect(store.busy(KEY)).toBe(false)

      expect(await engine.dispatch(ci('success'))).toBe('resumed')
      await comment
      expect(paused?.status).toBe('done')
      expect(ran).toEqual(['implementer:comment', 'triaged:comment'])
    })

    it('queued while the run was still going, it does not replace the pause that run took', async () => {
      const ran: string[] = []
      const { engine, store, ran: gate } = ciGate({ extra: [triage(ran)] })
      const build = engine.dispatch(event('build'))
      // Llega con la task ocupada: queda en cola detrás del implementer.
      const comment = engine.dispatch(event('comment'))
      await build
      await new Promise((resolve) => setTimeout(resolve, 0))
      const paused = store.current(KEY)
      expect(paused?.status).toBe('paused')
      expect(ran).toEqual([])

      expect(await engine.dispatch(ci('success'))).toBe('resumed')
      await comment
      expect(gate).toContain('review:check_suite')
      expect(ran).toEqual(['implementer:comment', 'triaged:comment'])
    })

    it('if another rule supersedes the pause meanwhile, it runs after that run', async () => {
      const ran: string[] = []
      const { engine, store, ran: gate } = ciGate({ extra: [triage(ran)] })
      await engine.dispatch(event('build'))
      const paused = store.current(KEY)
      const comment = engine.dispatch(event('comment'))
      await new Promise((resolve) => setTimeout(resolve, 0))

      // CI rojo: `ci-red` usa el default (`supersede`) y la reemplaza.
      expect(await engine.dispatch(ci('failure'))).toBe('dispatched')
      await comment
      expect(paused?.status).toBe('superseded')
      expect(gate.at(-1)).toBe('pushed:check_suite')
      expect(ran).toEqual(['implementer:comment', 'triaged:comment'])
    })

    it('also waits out a pause that ends through its timeout', async () => {
      const ran: string[] = []
      const { engine, store } = ciGate({ timeoutMs: 1_000, extra: [triage(ran)] })
      await engine.dispatch(event('build'))
      const paused = store.current(KEY)
      const comment = engine.dispatch(event('comment'))
      await new Promise((resolve) => setTimeout(resolve, 0))

      engine.tick(Date.now() + 2_000)
      await comment
      expect(paused?.status).toBe('done')
      expect(ran).toEqual(['implementer:comment', 'triaged:comment'])
    })
  })

  it('an expired pause resumes through its timeout branch on the next tick', async () => {
    const { engine, store, ran } = ciGate({ timeoutMs: 1_000 })
    await engine.dispatch(event('build'))
    const execution = store.current(KEY)

    engine.tick(Date.now())
    expect(execution?.status).toBe('paused')
    engine.tick(Date.now() + 2_000)
    await vi.waitFor(() => expect(execution?.status).toBe('done'))
    expect(ran.at(-1)).toBe('expired-note:execution.expired')
  })

  it('the expired event carries the task of the run that paused, so its branch knows the issue', async () => {
    const seen: unknown[] = []
    const note = new FunctionAction({ id: 'note', fn: (ctx) => void seen.push(ctx.event.payload) })
    const pipeline = new Pipeline({
      id: 'build',
      on: ['build'],
      do: [
        new PauseAction({
          id: 'wait-ci',
          branches: { green: { on: ['check_suite'], to: action('review', []) } },
          timeout: { afterMs: 1_000, to: note },
        }),
      ],
    })
    const store = new InMemoryExecutionStore()
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: { list: () => [pipeline] },
      executions: store,
    })
    await engine.dispatch(event('build', { owner: 'la-haus', repo: 'subscriptions', number: 7 }))
    const execution = store.current(KEY)

    engine.tick(Date.now() + 2_000)
    await vi.waitFor(() => expect(execution?.status).toBe('done'))

    expect(seen).toEqual([
      {
        owner: 'la-haus',
        repo: 'subscriptions',
        number: 7,
        executionId: execution?.id,
        pauseId: 'wait-ci',
      },
    ])
  })

  it('after the branch, the pipeline goes on with the rest of do[]', async () => {
    const ran: string[] = []
    const pipeline = new Pipeline({
      id: 'steps',
      on: ['start'],
      do: [
        implementer(ran)({ done: { to: action('before', ran) } }),
        new PauseAction({
          id: 'wait',
          branches: { go: { on: ['go'], to: action('branch', ran) } },
        }),
        action('after', ran),
      ],
    })
    const store = new InMemoryExecutionStore()
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([pipeline]),
      executions: store,
    })

    await engine.dispatch(event('start'))
    expect(ran).toEqual(['implementer:start', 'before:start'])
    await engine.dispatch(event('go'))
    expect(ran).toEqual(['implementer:start', 'before:start', 'branch:go', 'after:go'])
  })

  it('a pipeline without agents that can pause is an execution too', async () => {
    const ran: string[] = []
    const store = new InMemoryExecutionStore()
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([
        new Pipeline({
          id: 'plain',
          on: ['start'],
          do: [
            action('before', ran),
            new PauseAction({ id: 'wait', branches: { go: { on: ['go'] } } }),
            action('after', ran),
          ],
        }),
      ]),
      executions: store,
    })

    await engine.dispatch(event('start'))
    expect(store.current(KEY)?.status).toBe('paused')
    expect(await engine.dispatch(event('go'))).toBe('resumed')
    expect(ran).toEqual(['before:start', 'after:go'])
  })

  it('a pipeline nested in another execution cannot pause: it fails saying why', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const running = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Agent(
      { id: 'held', provider: 'held', prompt: 'p' },
      new ProviderRegistry().register({
        id: 'held',
        run: async () => {
          entered()
          await gate
          return { outcome: 'success' }
        },
      }),
    )
    const store = new InMemoryExecutionStore()
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([
        new Pipeline({ id: 'build', on: ['build'], do: [held] }),
        new Pipeline({
          id: 'nested',
          on: ['derived'],
          do: [new PauseAction({ id: 'wait', branches: { go: { on: ['go'] } } })],
        }),
      ]),
      executions: store,
    })

    const build = engine.dispatch(event('build'))
    await running
    const own = createEvent('derived', {}, { scope: TASK, executionId: store.current(KEY)?.id })
    await expect(engine.dispatch(own)).rejects.toThrow()
    release()
    await build
  })

  it('a pipeline that changed while paused does not resume at the wrong step', async () => {
    const ran: string[] = []
    const pipelines = [
      new Pipeline({
        id: 'plain',
        on: ['start'],
        do: [
          action('one', ran),
          new PauseAction({ id: 'wait', branches: { go: { on: ['go'] } } }),
          action('two', ran),
        ],
      }),
    ]
    const store = new InMemoryExecutionStore()
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: { list: () => pipelines },
      executions: store,
    })

    await engine.dispatch(event('start'))
    const paused = store.current(KEY)
    // Mientras espera, alguien agrega un paso antes de la pausa.
    pipelines[0] = new Pipeline({
      id: 'plain',
      on: ['start'],
      do: [
        action('zero', ran),
        action('one', ran),
        new PauseAction({ id: 'wait', branches: { go: { on: ['go'] } } }),
        action('two', ran),
      ],
    })

    await expect(engine.dispatch(event('go'))).rejects.toThrow()
    expect(paused?.status).toBe('failed')
    expect(ran).toEqual(['one:start'])
  })

  it('resumes in the project it paused in, even if another has a pipeline with the same id', async () => {
    const ran: string[] = []
    const build = (project: string) =>
      new Pipeline({
        id: 'build',
        on: ['start'],
        when: [new Condition({ field: 'project', op: 'eq', value: project })],
        do: [
          new PauseAction({
            id: 'wait',
            branches: { go: { on: ['go'], to: action(`after-${project}`, ran) } },
          }),
        ],
      })
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: [
        new StaticPipelineSource([build('a')], { id: 'a' }),
        new StaticPipelineSource([build('b')], { id: 'b' }),
      ],
      executions: new InMemoryExecutionStore(),
    })

    await engine.dispatch(event('start', { project: 'b' }))
    expect(await engine.dispatch(event('go'))).toBe('resumed')
    expect(ran).toEqual(['after-b:go'])
  })

  it('a pause needs executions: without them the pipeline fails loudly', async () => {
    const ran: string[] = []
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([
        new Pipeline({
          id: 'build',
          on: ['build'],
          do: [
            implementer(ran)({
              done: { to: new PauseAction({ id: 'wait', branches: { go: { on: ['go'] } } }) },
            }),
          ],
        }),
      ]),
    })
    await expect(engine.dispatch(event('build'))).rejects.toThrow()
  })
})

describe('Pipeline: where a pause can go', () => {
  const pause = () => new PauseAction({ id: 'wait', branches: { go: { on: ['go'] } } })
  const agent = (id: string, routes: Record<string, unknown> = {}, onError?: unknown) =>
    new Agent({
      id,
      provider: 'x',
      prompt: 'p',
      routes: routes as never,
      ...(onError ? { onError: onError as never } : {}),
    })
  const notify = () => new FunctionAction({ id: 'notify', fn: () => null })

  it('last in its list of targets — what follows would never resume', () => {
    expect(
      () =>
        new Pipeline({
          id: 'p',
          on: ['x'],
          do: [agent('a', { done: { to: [pause(), notify()] } })],
        }),
    ).toThrow(/"wait" puede pausar y no es el último destino/)
  })

  it('also through an agent that can pause further down', () => {
    const b = agent('b', { done: { to: pause() } })
    expect(
      () =>
        new Pipeline({
          id: 'p',
          on: ['x'],
          do: [agent('a', { done: {} })],
          routes: { a: { routes: { done: { to: [b, notify()] } } } },
        }),
    ).toThrow(/"b" puede pausar/)
  })

  it('never in an onError', () => {
    expect(
      () =>
        new Pipeline({
          id: 'p',
          on: ['x'],
          do: [agent('a', {}, { to: pause() })],
        }),
    ).toThrow(/un `onError` no puede pausar/)
  })

  it('a pause last in its list, or alone in do[], is fine', () => {
    expect(
      () =>
        new Pipeline({
          id: 'p',
          on: ['x'],
          do: [agent('a', { done: { to: [notify(), pause()] } })],
        }),
    ).not.toThrow()
    expect(() => new Pipeline({ id: 'q', on: ['x'], do: [pause(), notify()] })).not.toThrow()
  })
})

describe('PauseAction', () => {
  it('needs a branch or a timeout, and reserves the timeout branch name', () => {
    expect(() => new PauseAction({ id: 'p' })).toThrow(/nunca se reanudaría/)
    expect(() => new PauseAction({ id: 'p', branches: { timeout: { on: ['x'] } } })).toThrow(
      /rama de `timeout`/,
    )
  })

  it('its Pause says which branch an event wakes, and when it expires', async () => {
    const pause = await new PauseAction({
      id: 'p',
      branches: {
        green: {
          on: ['check_suite'],
          when: [new Condition({ field: 'conclusion', op: 'eq', value: 'success' })],
        },
        review: { on: ['pull_request_review'] },
      },
      timeout: { afterMs: 60_000 },
    }).run({} as never)

    expect(pause.match(ci('success'))).toBe('green')
    expect(pause.match(event('pull_request_review'))).toBe('review')
    expect(pause.match(ci('failure'))).toBeUndefined()
    expect(pause.expired(Date.now())).toBe(false)
    expect(pause.expired(Date.now() + 120_000)).toBe(true)
  })
})
