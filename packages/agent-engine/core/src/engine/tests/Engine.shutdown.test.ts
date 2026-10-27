import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry } from '../../agent/Provider.js'
import { createEvent, type DomainEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { Engine } from '../Engine.js'
import { ExecutionStore } from '../ExecutionStore.js'
import { InMemoryExecutionRepository } from '../InMemoryExecutionRepository.js'

const TASK = { projectId: 'p', issue: 7 }
const event = (type: string): DomainEvent => createEvent(type, {}, { scope: TASK })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Un agente que guarda su conversación y muere cuando el test lo dice (el apagado le cierra la
 *  base: "Cannot use a closed database"). */
function dyingAgent() {
  let die!: (error: Error) => void
  const registry = new ProviderRegistry().register({
    id: 'scripted',
    run: (ctx) => {
      ctx.saveConversation?.(['vuelta-1'])
      return new Promise((_, reject) => {
        die = reject
      })
    },
  })
  const implementer = new Agent(
    { id: 'implementer', provider: 'scripted', prompt: 'implementá' },
    registry,
  )
  return { implementer, die: (message: string) => die(new Error(message)) }
}

describe('an execution running when the process shuts down (subscriptions#1940)', () => {
  it('does not run its onError and stays saved as running, so the restart resumes it', async () => {
    const blocked: string[] = []
    const { implementer, die } = dyingAgent()
    const repository = new InMemoryExecutionRepository()
    const store = new ExecutionStore({ repository })
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: {
        list: () => [
          new Pipeline({
            id: 'build',
            on: ['build'],
            do: [implementer],
            onError: {
              to: new FunctionAction({ id: 'blocked', fn: () => void blocked.push('+blocked') }),
            },
          }),
        ],
      },
      executions: store,
    })

    const dispatched = engine.dispatch(event('build')).catch(() => {})
    await flush()
    store.close()
    die('Cannot use a closed database')
    await dispatched

    expect(blocked).toEqual([])
    expect(repository.live()).toEqual([
      expect.objectContaining({
        status: 'running',
        checkpoint: expect.objectContaining({ pauseId: 'implementer' }),
      }),
    ])
    // Al reiniciar se retoma desde su conversación, no queda `failed`.
    expect(new ExecutionStore({ repository }).paused()).toHaveLength(1)
  })

  it('without a shutdown, the same failure runs its onError', async () => {
    const blocked: string[] = []
    const { implementer, die } = dyingAgent()
    const store = new ExecutionStore({ repository: new InMemoryExecutionRepository() })
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: {
        list: () => [
          new Pipeline({
            id: 'build',
            on: ['build'],
            do: [implementer],
            onError: {
              to: new FunctionAction({ id: 'blocked', fn: () => void blocked.push('+blocked') }),
            },
          }),
        ],
      },
      executions: store,
    })

    const dispatched = engine.dispatch(event('build'))
    await flush()
    die('boom')
    await dispatched

    expect(blocked).toEqual(['+blocked'])
  })

  it('once closed, what was waiting for its turn never starts nor touches the repository', async () => {
    const repository = new InMemoryExecutionRepository()
    const store = new ExecutionStore({ repository })
    const running = await store.start({ key: 'k', pipelineId: 'build', event: event('build') })
    let started = false
    void store.start({ key: 'k', pipelineId: 'review', event: event('review') }).then(() => {
      started = true
    })
    await flush()

    store.close()
    repository.save = () => {
      throw new Error('Cannot use a closed database')
    }
    running.close('done')
    void store.start({ key: 'other', pipelineId: 'build' }).then(() => {
      started = true
    })
    await flush()

    expect(started).toBe(false)
  })
})
