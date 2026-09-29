import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import type { Provider } from '../../agent/Provider.js'
import { ProviderRegistry } from '../../agent/Provider.js'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { Engine } from '../Engine.js'
import { InMemoryExecutionStore } from '../InMemoryExecutionStore.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const forTask = (issue: number) => createEvent('build', {}, { scope: { projectId: 'p', issue } })

/** Un provider cuyas corridas terminan cuando el test las suelta. */
function gatedProvider(extra: Partial<Provider> = {}) {
  const started: string[] = []
  const gates: Array<() => void> = []
  const provider: Provider = {
    id: 'gated',
    ...extra,
    run: async (ctx) => {
      started.push(String(ctx.ctx.event.scope?.issue))
      await new Promise<void>((resolve) => gates.push(resolve))
      await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
      return { outcome: 'success' }
    },
  }
  return { provider, started, finishNext: () => gates.shift()?.() }
}

function engineWith(provider: Provider, agent: { maxConcurrent?: number } = {}, limits = true) {
  const implementer = new Agent(
    { id: 'implementer', provider: provider.id, prompt: 'p', ...agent },
    new ProviderRegistry().register(provider),
  )
  return new Engine({
    bus: new EventBus(),
    pipelines: { list: () => [new Pipeline({ id: 'build', on: ['build'], do: [implementer] })] },
    executions: new InMemoryExecutionStore(),
    limits,
  })
}

describe('Engine limits', () => {
  it('an agent maxConcurrent keeps a second task waiting until the first one finishes', async () => {
    const { provider, started, finishNext } = gatedProvider()
    const engine = engineWith(provider, { maxConcurrent: 1 })

    const first = engine.dispatch(forTask(1))
    const second = engine.dispatch(forTask(2))
    await tick()
    expect(started).toEqual(['1'])

    finishNext()
    await first
    await tick()
    expect(started).toEqual(['1', '2'])
    finishNext()
    await second
  })

  it('a provider maxConcurrent caps every agent on it', async () => {
    const { provider, started, finishNext } = gatedProvider({ maxConcurrent: 1 })
    const engine = engineWith(provider)

    const runs = [engine.dispatch(forTask(1)), engine.dispatch(forTask(2))]
    await tick()
    expect(started).toEqual(['1'])
    finishNext()
    await tick()
    await tick()
    expect(started).toEqual(['1', '2'])
    finishNext()
    await Promise.all(runs)
  })

  it('without limits, the caps are not applied', async () => {
    const { provider, started, finishNext } = gatedProvider({ maxConcurrent: 1 })
    const engine = engineWith(provider, {}, false)

    const runs = [engine.dispatch(forTask(1)), engine.dispatch(forTask(2))]
    await tick()
    expect(started).toEqual(['1', '2'])
    finishNext()
    finishNext()
    await Promise.all(runs)
  })

  it('a provider that cannot take the run now delays it instead of failing it', async () => {
    let asked = 0
    const { provider, started, finishNext } = gatedProvider({
      canAccept: async () =>
        ++asked < 3 ? { accept: false, reason: 'host lleno', retryAfterMs: 1 } : { accept: true },
    })
    const engine = engineWith(provider)

    const run = engine.dispatch(forTask(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(asked).toBe(3)
    expect(started).toEqual(['1'])
    finishNext()
    await run
  })
})
