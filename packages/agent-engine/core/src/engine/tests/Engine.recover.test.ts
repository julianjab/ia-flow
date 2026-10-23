import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import type { Provider, ProviderRunContext } from '../../agent/Provider.js'
import { ProviderRegistry } from '../../agent/Provider.js'
import { Condition } from '../../condition/Condition.js'
import { createEvent, type DomainEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { PauseAction } from '../../pipeline/actions/PauseAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { Engine, scopeExecutionKey } from '../Engine.js'
import type { ExecutionRecord } from '../Execution.js'
import { ExecutionStore, RESTART_NOTE } from '../ExecutionStore.js'
import { InMemoryExecutionRepository } from '../InMemoryExecutionRepository.js'
import { DEFAULT_RESUME_LIMITS, resumeDelayMs } from '../ResumeLimits.js'

const TASK = { projectId: 'p', issue: 7 }
const event = (type: string, payload: Record<string, unknown> = {}): DomainEvent =>
  createEvent(type, payload, { scope: TASK })
const KEY = scopeExecutionKey(event('x')) as string
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const hang = () => new Promise<never>(() => {})

/** Un provider que corre un guion: cada corrida del agente es el paso que sigue. */
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

const submitsDone = async (ctx: ProviderRunContext) => {
  await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
  return { outcome: 'success' as const }
}

/**
 * El gate de CI del roster: el implementer termina, se asegura el PR y espera el CI; verde →
 * Review. `review` es lo que corre la rama `green`: el test decide si cuelga (el proceso muere ahí).
 */
function ciGate(
  registry: ProviderRegistry,
  ran: string[],
  review: () => unknown,
  repository = new InMemoryExecutionRepository(),
) {
  const step = (id: string, fn: () => unknown = () => {}) =>
    new FunctionAction({
      id,
      fn: (ctx) => {
        ran.push(`${id}:${ctx.event.type}`)
        return fn() as void
      },
    })
  const waitCi = new PauseAction({
    id: 'wait-ci',
    branches: {
      green: {
        on: ['check_suite'],
        when: [new Condition({ field: 'conclusion', op: 'eq', value: 'success' })],
        to: step('review', review),
      },
    },
    timeout: { afterMs: 30 * 60_000, to: step('expired') },
  })
  const implementer = new Agent(
    {
      id: 'implementer',
      provider: 'scripted',
      prompt: 'implementá',
      routes: { done: { to: [step('ensure-pr'), waitCi] } },
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

describe('an execution the process cut right after its pause woke up', () => {
  it('keeps the pause checkpoint with the branch that woke it, and resumes by that branch', async () => {
    const ran: string[] = []
    const first = scripted([submitsDone])
    const { engine, repository } = ciGate(first.registry, ran, hang)

    await engine.dispatch(event('build'))
    void engine.dispatch(event('check_suite', { conclusion: 'success' }))
    await flush()
    // El proceso muere con la rama `green` a medio correr (subscriptions#1977).
    expect(ran).toEqual(['ensure-pr:build', 'review:check_suite'])
    expect(repository.live()[0]).toMatchObject({
      status: 'running',
      checkpoint: { pauseId: 'wait-ci', branch: 'green' },
    })

    // Reinicio: otro store y otro engine sobre el mismo repositorio.
    const restarted = ciGate(scripted([]).registry, ran, () => {}, repository)
    expect(restarted.store.current(KEY)?.status).toBe('paused')
    restarted.engine.tick()
    await restarted.store.current(KEY)?.finished

    // Vuelve a correr la rama que la despertó — no `timeout`, y sin rehacer al implementer.
    expect(ran).toEqual(['ensure-pr:build', 'review:check_suite', 'review:execution.expired'])
    expect(repository.live()).toEqual([])
  })

  it('a pause that wakes and finishes leaves nothing to resume', async () => {
    const ran: string[] = []
    const { engine, repository } = ciGate(scripted([submitsDone]).registry, ran, () => {})

    await engine.dispatch(event('build'))
    await engine.dispatch(event('check_suite', { conclusion: 'success' }))

    expect(ran).toEqual(['ensure-pr:build', 'review:check_suite'])
    expect(repository.live()).toEqual([])
  })
})

describe('an agent resumed after a restart that dies again before its first round', () => {
  const dies = (ctx: ProviderRunContext) => {
    ctx.saveConversation?.(['vuelta-1'])
    return hang()
  }

  function build(registry: ProviderRegistry, repository: InMemoryExecutionRepository) {
    const implementer = new Agent(
      { id: 'implementer', provider: 'scripted', prompt: 'implementá' },
      registry,
    )
    const store = new ExecutionStore({ repository })
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: { list: () => [new Pipeline({ id: 'build', on: ['build'], do: [implementer] })] },
      executions: store,
    })
    return { engine, store }
  }

  it('keeps its saved conversation, so the next restart still resumes it', async () => {
    const repository = new InMemoryExecutionRepository()
    void build(scripted([dies]).registry, repository).engine.dispatch(event('build'))
    await flush()

    // Primer reinicio: se retoma y el proceso muere otra vez antes de que el agente guarde nada.
    const second = build(scripted([hang]).registry, repository)
    second.engine.tick()
    await flush()
    expect(repository.live()[0]).toMatchObject({
      status: 'running',
      checkpoint: {
        pauseId: 'implementer',
        state: { provider: 'scripted', conversation: ['vuelta-1'] },
        attempts: 1,
      },
    })

    // Segundo reinicio: sigue retomable, con su conversación, y cuenta el intento.
    const third = scripted([submitsDone])
    const restarted = build(third.registry, repository)
    expect(restarted.store.current(KEY)?.toRecord().checkpoint?.attempts).toBe(2)
    restarted.engine.tick(Date.now() + DEFAULT_RESUME_LIMITS.backoffMs)
    await restarted.store.current(KEY)?.finished

    expect(third.seen[0]?.resume).toEqual({ conversation: ['vuelta-1'], message: RESTART_NOTE })
    expect(repository.live()).toEqual([])
  })
})

describe('resuming what the process cut', () => {
  const running = (
    repository: InMemoryExecutionRepository,
    id: string,
    attempts?: number,
  ): ExecutionRecord => {
    const record: ExecutionRecord = {
      id,
      key: `${KEY}-${id}`,
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
        ...(attempts ? { attempts } : {}),
      },
    }
    repository.save(record)
    return record
  }
  const dueIn = (store: ExecutionStore, id: string, now: number) => {
    const record = store
      .paused()
      .map((execution) => execution.toRecord())
      .find((candidate) => candidate.id === id)
    return (record?.pause?.expiresAt as number) - now
  }

  it('staggers the ones of one restart, and waits longer on each attempt', () => {
    const repository = new InMemoryExecutionRepository()
    running(repository, 'a')
    running(repository, 'b')
    running(repository, 'c', 2)
    const now = Date.now()

    const store = new ExecutionStore({
      repository,
      resume: { backoffMs: 30_000, staggerMs: 60_000 },
    })

    // `a` en el acto; `b` un minuto después; `c` (tercer intento) espera 60 s más dos lugares.
    expect(dueIn(store, 'a', now)).toBeLessThan(1_000)
    expect(dueIn(store, 'b', now)).toBeGreaterThanOrEqual(60_000)
    expect(dueIn(store, 'b', now)).toBeLessThan(61_000)
    expect(dueIn(store, 'c', now)).toBeGreaterThanOrEqual(180_000)
    expect(dueIn(store, 'c', now)).toBeLessThan(181_000)
  })

  it('closes as interrupted one that ran without a checkpoint', () => {
    const repository = new InMemoryExecutionRepository()
    repository.save({
      id: 'z',
      key: KEY,
      pipelineId: 'build',
      status: 'running',
      startedAt: new Date().toISOString(),
      waitedMs: 0,
    })

    const store = new ExecutionStore({ repository })

    expect(store.paused()).toEqual([])
    expect(repository.live()).toEqual([])
  })
})

describe('resumeDelayMs', () => {
  const limits = { ...DEFAULT_RESUME_LIMITS, backoffMs: 1_000, maxBackoffMs: 5_000, staggerMs: 10 }

  it('does not wait the first time, then doubles up to the ceiling', () => {
    expect([1, 2, 3, 4, 5, 6].map((attempt) => resumeDelayMs(attempt, 0, limits))).toEqual([
      0, 1_000, 2_000, 4_000, 5_000, 5_000,
    ])
  })

  it('adds the stagger for each one resumed before it', () => {
    expect(resumeDelayMs(1, 3, limits)).toBe(30)
    expect(resumeDelayMs(2, 1, limits)).toBe(1_010)
  })
})
