import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry } from '../../agent/Provider.js'
import { EventFilter } from '../../condition/EventFilter.js'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { Pause } from '../../pipeline/actions/Pause.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { Engine, scopeExecutionKey } from '../Engine.js'
import { ExecutionStore } from '../ExecutionStore.js'
import { InMemoryExecutionRepository } from '../InMemoryExecutionRepository.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const pause = () =>
  new Pause('wait-ci', [{ name: 'green', filter: new EventFilter({ on: ['ci'] }) }], 5_000)
const checkpoint = {
  pipelineId: 'build',
  pauseId: 'wait-ci',
  resumeAt: 1,
  steps: {},
  shape: 'implementer → wait-ci',
}

/** Un reinicio: un store nuevo sobre el mismo repositorio. */
const restart = (repository: InMemoryExecutionRepository) => new ExecutionStore({ repository })

describe('ExecutionStore with a repository', () => {
  it('writes every transition of its executions to the repository', async () => {
    const repository = new InMemoryExecutionRepository()
    const store = new ExecutionStore({ repository })
    const execution = await store.start({ key: 't', pipelineId: 'build' })
    expect(repository.live()).toEqual([
      expect.objectContaining({ id: 'exec-1', status: 'running' }),
    ])

    await execution.run(async () => execution.pause(pause(), checkpoint))
    expect(repository.live()[0]).toMatchObject({
      status: 'paused',
      checkpoint,
      pause: { pauseId: 'wait-ci', expiresAt: 5_000 },
    })

    execution.wake(createEvent('ci', {}))
    expect(repository.live()[0]?.status).toBe('running')
    await store.resume(execution)
    await execution.run(async () => undefined)
    expect(repository.live()).toEqual([])
  })

  it('after a restart, a paused execution is waiting again and wakes as before', async () => {
    const repository = new InMemoryExecutionRepository()
    const before = new ExecutionStore({ repository })
    const execution = await before.start({ key: 't', pipelineId: 'build' })
    await execution.run(async () => execution.pause(pause(), checkpoint))

    const after = restart(repository)
    const restored = after.current('t')
    expect(restored).not.toBe(execution)
    expect(restored?.id).toBe(execution.id)
    expect(restored?.status).toBe('paused')
    expect(after.paused()).toEqual([restored])
    expect(after.busy('t')).toBe(false)
    expect(restored?.expired(5_000)).toBe(true)
    expect(restored?.wake(createEvent('ci', {}))).toEqual({ branch: 'green', checkpoint })
  })

  it('after a restart, a running execution is closed as interrupted and hands back what it did not read', async () => {
    const repository = new InMemoryExecutionRepository()
    const before = new ExecutionStore({ repository })
    const execution = await before.start({ key: 't', pipelineId: 'build' })
    const comment = createEvent('comment', {})
    execution.enter(
      new Agent({ id: 'a', provider: 'p', prompt: 'p', injects: [{ on: ['comment'] }] }),
    )
    execution.inject('hola', comment)

    const after = restart(repository)
    expect(after.current('t')).toBeUndefined()
    expect(after.takeOrphaned()).toEqual([{ executionId: execution.id, events: [comment] }])
    expect(after.takeOrphaned()).toEqual([])
    expect(repository.live()).toEqual([])
  })

  it('the Engine re-dispatches what an interrupted execution never read', async () => {
    const repository = new InMemoryExecutionRepository()
    const TASK = { issue: 1 }
    const key = scopeExecutionKey(createEvent('x', {}, { scope: TASK })) as string
    const before = new ExecutionStore({ repository })
    const interrupted = await before.start({ key, pipelineId: 'build' })
    interrupted.enter(
      new Agent({ id: 'a', provider: 'p', prompt: 'p', injects: [{ on: ['comment'] }] }),
    )
    interrupted.inject('hola', createEvent('comment', { body: 'hola' }, { scope: TASK }))

    const seen: string[] = []
    const replier = new Agent(
      { id: 'replier', provider: 'reply', prompt: 'p' },
      new ProviderRegistry().register({
        id: 'reply',
        run: async (ctx) => {
          seen.push(ctx.ctx.event.type)
          return { outcome: 'done' }
        },
      }),
    )
    new Engine({
      bus: new EventBus(),
      pipelines: { list: () => [new Pipeline({ id: 'reply', on: ['comment'], do: [replier] })] },
      executions: restart(repository),
    })
    await tick()
    await tick()
    expect(seen).toEqual(['comment'])
  })
})
