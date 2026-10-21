import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry, type ProviderRunContext } from '../../agent/Provider.js'
import { createEvent, type DomainEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { ParallelGroup } from '../../pipeline/ParallelGroup.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { Engine, scopeExecutionKey } from '../Engine.js'
import { ExecutionStore, RESTART_NOTE } from '../ExecutionStore.js'
import { InMemoryExecutionRepository } from '../InMemoryExecutionRepository.js'

const TASK = { projectId: 'p', issue: 1918 }
const event = (type: string): DomainEvent => createEvent(type, {}, { scope: TASK })
const KEY = scopeExecutionKey(event('x')) as string

type Turn = (ctx: ProviderRunContext) => Promise<{ outcome: 'success' }>

const submits =
  (exit: string): Turn =>
  async (ctx) => {
    await ctx.tools.find((tool) => tool.name === `submit_${exit}`)?.handler({})
    return { outcome: 'success' }
  }
/** Guarda su conversación (si trae una) y se cuelga: el proceso "muere" con el miembro en curso. */
const dies =
  (conversation?: string[]): Turn =>
  (ctx) => {
    if (conversation) ctx.saveConversation?.(conversation)
    return new Promise<never>(() => {})
  }

type MemberId = 'reviewer' | 'e2e'

/** El gate de Review: reviewer + e2e a la vez, y `slack-review` si los dos aprueban. */
function build(turns: Record<MemberId, Turn[]>, repository = new InMemoryExecutionRepository()) {
  const ran: string[] = []
  const seen: Record<MemberId, ProviderRunContext[]> = { reviewer: [], e2e: [] }
  const registry = new ProviderRegistry()
  for (const id of ['reviewer', 'e2e'] as const) {
    registry.register({
      id,
      run: (ctx) => {
        const turn = turns[id][seen[id].length]
        seen[id].push(ctx)
        if (!turn) throw new Error(`${id} no tiene más vueltas en el guion`)
        return turn(ctx)
      },
    })
  }
  const member = (id: MemberId, exit: string) =>
    new Agent(
      {
        id,
        provider: id,
        prompt: `prompt de ${id}`,
        onStart: new FunctionAction({
          id: `start-${id}`,
          fn: () => void ran.push(`onStart:${id}`),
        }),
        routes: { [exit]: {} },
      },
      registry,
    )
  const gate = new ParallelGroup({
    id: 'gate',
    members: [member('reviewer', 'approved'), member('e2e', 'passed')],
    until: { all: ['approved', 'passed'] },
    routes: {
      passed: { to: new FunctionAction({ id: 'slack', fn: () => void ran.push('slack-review') }) },
    },
  })
  const store = new ExecutionStore({ repository })
  const engine = new Engine({
    bus: new EventBus(),
    pipelines: { list: () => [new Pipeline({ id: 'review', on: ['review'], do: [gate] })] },
    executions: store,
  })
  return { engine, store, repository, ran, seen }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a parallel group whose process died mid-run', () => {
  it('is resumed: the member that voted keeps its verdict, the other resumes its conversation', async () => {
    const first = build({ reviewer: [submits('approved')], e2e: [dies(['e2e-1', 'e2e-2'])] })
    void first.engine.dispatch(event('review'))
    await settle()
    await settle()
    expect(first.repository.live()[0]?.checkpoint).toMatchObject({
      pauseId: 'gate',
      state: {
        members: {
          reviewer: { verdict: { exit: 'approved' } },
          e2e: { state: { provider: 'e2e', conversation: ['e2e-1', 'e2e-2'] } },
        },
      },
    })

    // Reinicio: otro store y otro engine sobre el mismo repositorio.
    const second = build({ reviewer: [], e2e: [submits('passed')] }, first.repository)
    expect(second.store.current(KEY)?.status).toBe('paused')
    second.engine.tick()
    await second.store.current(KEY)?.finished

    expect(second.seen.reviewer).toHaveLength(0)
    expect(second.seen.e2e[0]?.resume).toEqual({
      conversation: ['e2e-1', 'e2e-2'],
      message: RESTART_NOTE,
    })
    // El `onStart` de cada miembro corrió sólo la primera vez.
    expect([...first.ran, ...second.ran]).toEqual([
      'onStart:reviewer',
      'onStart:e2e',
      'slack-review',
    ])
  })

  it('is resumed even before any member saved anything, with the restart note in each prompt', async () => {
    const first = build({ reviewer: [dies()], e2e: [dies()] })
    void first.engine.dispatch(event('review'))
    await settle()
    await settle()
    expect(first.repository.live()[0]?.checkpoint).toMatchObject({
      pauseId: 'gate',
      state: { members: {} },
    })

    const second = build(
      { reviewer: [submits('approved')], e2e: [submits('passed')] },
      first.repository,
    )
    second.engine.tick()
    await second.store.current(KEY)?.finished

    expect(second.seen.reviewer[0]?.prompt).toContain(RESTART_NOTE)
    expect(second.seen.e2e[0]?.prompt).toContain(RESTART_NOTE)
    expect(second.ran).toEqual(['slack-review'])
  })

  it('leaves no checkpoint behind once the group finished', async () => {
    const run = build({ reviewer: [submits('approved')], e2e: [submits('passed')] })
    await run.engine.dispatch(event('review'))
    await run.store.current(KEY)?.finished
    expect(run.repository.live()).toHaveLength(0)
    expect(run.ran).toEqual(['onStart:reviewer', 'onStart:e2e', 'slack-review'])
  })
})
