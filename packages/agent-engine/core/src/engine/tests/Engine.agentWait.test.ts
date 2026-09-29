import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import type { Provider, ProviderRunContext } from '../../agent/Provider.js'
import { ProviderRegistry } from '../../agent/Provider.js'
import { createEvent, type DomainEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { Engine, scopeExecutionKey } from '../Engine.js'
import { ExecutionStore, RESTART_NOTE } from '../ExecutionStore.js'
import { InMemoryExecutionRepository } from '../InMemoryExecutionRepository.js'

const TASK = { projectId: 'p', issue: 7 }
const event = (type: string, payload: Record<string, unknown> = {}): DomainEvent =>
  createEvent(type, payload, { scope: TASK })
const KEY = scopeExecutionKey(event('x')) as string

/** Un provider que corre un guion: cada vuelta recibe lo que vio el agente y decide. */
function scripted(steps: Array<(ctx: ProviderRunContext) => ReturnType<Provider['run']>>) {
  const seen: ProviderRunContext[] = []
  const registry = new ProviderRegistry().register({
    id: 'scripted',
    run: async (ctx) => {
      const step = steps[seen.length]
      seen.push(ctx)
      if (!step) throw new Error(`no hay paso ${seen.length} en el guion`)
      return step(ctx)
    },
  })
  return { registry, seen }
}

const call = async (ctx: ProviderRunContext, name: string, input: unknown) => {
  const tool = ctx.tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`el agente no ofreció ${name}`)
  return tool.handler(input)
}

/** Espera el CI a mitad de turno y, al volver, elige `done`. */
const waitsForCi = (ctx: ProviderRunContext) =>
  call(ctx, 'wait_for_event', {
    on: ['check_suite'],
    when: [{ field: 'conclusion', op: 'eq', value: 'success' }],
    timeoutMinutes: 30,
    reason: 'espero el CI',
  }).then(() => ({ outcome: 'success', conversation: ['turno-1'] }))
const submitsDone = (ctx: ProviderRunContext) =>
  call(ctx, 'submit_done', {}).then(() => ({ outcome: 'success' }))

function build(
  registry: ProviderRegistry,
  ran: string[],
  repository = new InMemoryExecutionRepository(),
) {
  const implementer = new Agent(
    {
      id: 'implementer',
      provider: 'scripted',
      prompt: 'implementá',
      waits: { on: ['check_suite', 'issue_comment'] },
      onStart: new FunctionAction({ id: 'claim', fn: () => void ran.push('onStart') }),
      routes: {
        done: { to: new FunctionAction({ id: 'review', fn: () => void ran.push('review') }) },
      },
    },
    registry,
  )
  const store = new ExecutionStore({ repository })
  const engine = new Engine({
    bus: new EventBus(),
    pipelines: { list: () => [new Pipeline({ id: 'build', on: ['build'], do: [implementer] })] },
    executions: store,
  })
  return { engine, store, repository }
}

describe('an agent that waits for an event mid-turn', () => {
  it('pauses the execution with its conversation, and resumes it with the event that woke it', async () => {
    const { registry, seen } = scripted([waitsForCi, submitsDone])
    const ran: string[] = []
    const { engine, store } = build(registry, ran)

    await engine.dispatch(event('build'))
    const paused = store.current(KEY)
    expect(paused?.status).toBe('paused')
    expect(paused?.toRecord().checkpoint).toMatchObject({
      pauseId: 'implementer',
      state: ['turno-1'],
    })
    expect(ran).toEqual(['onStart'])

    // Un CI rojo no es el evento que espera.
    await engine.dispatch(event('check_suite', { conclusion: 'failure' }))
    expect(store.current(KEY)?.status).toBe('paused')

    await engine.dispatch(event('check_suite', { conclusion: 'success' }))

    expect(ran).toEqual(['onStart', 'review'])
    expect(seen[1]?.resume?.conversation).toEqual(['turno-1'])
    expect(seen[1]?.resume?.message).toMatch(/Llegó el evento que esperabas \(check_suite\)/)
    expect(seen[1]?.resume?.message).toContain('"conclusion": "success"')
    expect(store.current(KEY)).toBeUndefined()
  })

  it('resumes by timeout with a notice when the event never comes', async () => {
    const { registry, seen } = scripted([waitsForCi, submitsDone])
    const ran: string[] = []
    const { engine, store } = build(registry, ran)

    await engine.dispatch(event('build'))
    engine.tick(Date.now() + 31 * 60_000)
    await store.current(KEY)?.finished

    expect(seen[1]?.resume?.message).toMatch(/Venció la espera/)
    expect(ran).toEqual(['onStart', 'review'])
  })

  it('only offers wait_for_event with the event types it declares', async () => {
    const { registry, seen } = scripted([
      async (ctx) => {
        await expect(call(ctx, 'wait_for_event', { on: ['push'], reason: 'x' })).rejects.toThrow()
        return submitsDone(ctx)
      },
    ])
    const { engine } = build(registry, [])
    await engine.dispatch(event('build'))
    expect(seen[0]?.tools.map((tool) => tool.name)).toContain('wait_for_event')
  })

  it('an agent that waits must be the last destination of an exit', () => {
    const waiter = new Agent(
      { id: 'waiter', provider: 'x', prompt: 'p', waits: { on: ['a'] } },
      new ProviderRegistry(),
    )
    const router = new Agent(
      { id: 'router', provider: 'x', prompt: 'p', routes: { go: { when: 'x' } } },
      new ProviderRegistry(),
    )
    expect(
      () =>
        new Pipeline({
          id: 'p',
          on: ['a'],
          do: [router],
          routes: {
            router: { routes: { go: { to: [waiter, new FunctionAction({ fn: () => {} })] } } },
          },
        }),
    ).toThrow(/puede pausar y no es el último destino/)
  })
})

describe('an agent whose process died mid-turn', () => {
  /** Guarda su conversación y se cuelga: el proceso "muere" con ella en curso. */
  const dies = (ctx: ProviderRunContext) => {
    ctx.saveConversation?.(['vuelta-1', 'vuelta-2'])
    return new Promise<never>(() => {})
  }

  it('is resumed from its saved conversation after a restart, without re-running onStart', async () => {
    const first = scripted([dies])
    const ran: string[] = []
    const { engine, repository } = build(first.registry, ran)
    void engine.dispatch(event('build'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(repository.live()[0]?.checkpoint).toMatchObject({
      pauseId: 'implementer',
      state: ['vuelta-1', 'vuelta-2'],
    })

    // Reinicio: otro store y otro engine sobre el mismo repositorio.
    const second = scripted([submitsDone])
    const restarted = build(second.registry, ran, repository)
    expect(restarted.store.current(KEY)?.status).toBe('paused')
    restarted.engine.tick()
    await restarted.store.current(KEY)?.finished

    expect(second.seen[0]?.resume).toEqual({
      conversation: ['vuelta-1', 'vuelta-2'],
      message: RESTART_NOTE,
    })
    expect(ran).toEqual(['onStart', 'review'])
  })

  it('tells the resumed agent what arrived while it was down', async () => {
    const repository = new InMemoryExecutionRepository()
    repository.save({
      id: 'exec-9',
      key: KEY,
      pipelineId: 'build',
      status: 'running',
      startedAt: new Date().toISOString(),
      waitedMs: 0,
      checkpoint: {
        pipelineId: 'build',
        pauseId: 'implementer',
        resumeAt: 1,
        steps: {},
        shape: 'implementer',
        state: ['c'],
        savedAt: new Date().toISOString(),
      },
    })
    repository.delivered('exec-9', event('issue_comment', { body: 'ojo con X' }))
    const { registry, seen } = scripted([submitsDone])
    const { engine, store } = build(registry, [], repository)

    engine.tick()
    await store.current(KEY)?.finished

    expect(seen[0]?.resume?.message).toContain(RESTART_NOTE)
    expect(seen[0]?.resume?.message).toContain('issue_comment')
    expect(seen[0]?.resume?.message).toContain('ojo con X')
  })

  it('is closed as interrupted past the attempts cap, or without a saved conversation', () => {
    const repository = new InMemoryExecutionRepository()
    const running = (id: string, checkpoint?: Record<string, unknown>) =>
      repository.save({
        id,
        key: `${KEY}-${id}`,
        pipelineId: 'build',
        status: 'running',
        startedAt: new Date().toISOString(),
        waitedMs: 0,
        ...(checkpoint
          ? {
              checkpoint: {
                pipelineId: 'build',
                pauseId: 'implementer',
                resumeAt: 1,
                steps: {},
                shape: 'implementer',
                ...checkpoint,
              },
            }
          : {}),
      })
    running('a', { state: ['c'], attempts: 10 })
    running('b')
    running('c', { state: ['c'], savedAt: new Date(Date.now() - 25 * 3_600_000).toISOString() })

    const store = new ExecutionStore({ repository })

    expect(store.paused()).toEqual([])
    expect(repository.live()).toEqual([])
  })

  it('a step that finished clears its saved progress: a crash later does not re-run it', async () => {
    const ran: string[] = []
    const { registry } = scripted([
      async (ctx) => {
        ctx.saveConversation?.(['c'])
        return submitsDone(ctx)
      },
    ])
    const repository = new InMemoryExecutionRepository()
    const saved: unknown[] = []
    const save = repository.save.bind(repository)
    repository.save = (record) => {
      saved.push(record.checkpoint?.state)
      save(record)
    }
    const { engine } = build(registry, ran, repository)

    await engine.dispatch(event('build'))

    expect(saved).toContainEqual(['c'])
    expect(saved.at(-1)).toBeUndefined()
  })
})
