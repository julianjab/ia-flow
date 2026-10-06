import { describe, expect, it } from 'vitest'
import { Condition } from '../../condition/Condition.js'
import { ConcurrencyLimits } from '../../engine/ConcurrencyLimits.js'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import type { PipelineExecutionContext } from '../../pipeline/Runnable.js'
import { Agent } from '../Agent.js'
import type { Provider, ProviderRunContext } from '../Provider.js'
import { ProviderRegistry } from '../Provider.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Un provider que cierra con `submit_done` cuando el test lo suelta (o enseguida). */
function provider(id: string, extra: Partial<Provider> = {}, gate?: Promise<void>) {
  const runs: ProviderRunContext[] = []
  const p: Provider = {
    id,
    ...extra,
    run: async (ctx) => {
      runs.push(ctx)
      await gate
      await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
      return { outcome: 'success' }
    },
  }
  return { provider: p, runs }
}

const ctx = (
  limits = new ConcurrencyLimits(),
  payload: Record<string, unknown> = {},
): PipelineExecutionContext => ({
  event: createEvent('build', payload),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'build',
  limits,
})

function agent(registry: ProviderRegistry, providers: Agent['definition']['providers']) {
  return new Agent(
    { id: 'implementer', prompt: 'p', ...(providers ? { providers } : {}) },
    registry,
  )
}

describe('Agent with several provider candidates', () => {
  it('runs in the first one with room, each with its own config', async () => {
    let free!: () => void
    const tmux = provider('claude-tmux', { maxConcurrent: 1 }, new Promise((r) => (free = r)))
    const api = provider('anthropic-api')
    const registry = new ProviderRegistry().register(tmux.provider).register(api.provider)
    const implementer = agent(registry, [
      { id: 'claude-tmux', config: { model: 'opus' } },
      { id: 'anthropic-api', config: { maxTokens: 1 } },
    ])
    const limits = new ConcurrencyLimits()

    const first = implementer.run(ctx(limits))
    await tick()
    const second = await implementer.run(ctx(limits))

    expect(tmux.runs[0]?.providerConfig).toEqual({ model: 'opus' })
    expect(second.provider).toBe('anthropic-api')
    expect(api.runs[0]?.providerConfig).toEqual({ maxTokens: 1 })
    free()
    expect((await first).provider).toBe('claude-tmux')
  })

  it('a provider that declines (canAccept) is skipped for the next one', async () => {
    const remote = provider('remote', {
      canAccept: async () => ({ accept: false, reason: 'host lleno' }),
    })
    const api = provider('anthropic-api')
    const registry = new ProviderRegistry().register(remote.provider).register(api.provider)

    const result = await agent(registry, [{ id: 'remote' }, { id: 'anthropic-api' }]).run(ctx())

    expect(result.provider).toBe('anthropic-api')
    expect(remote.runs).toEqual([])
  })

  it('a candidate whose when does not match the event is not a candidate', async () => {
    const tmux = provider('claude-tmux')
    const api = provider('anthropic-api')
    const registry = new ProviderRegistry().register(tmux.provider).register(api.provider)
    const implementer = agent(registry, [
      {
        id: 'claude-tmux',
        when: Condition.fromRows([{ field: 'repo', op: 'eq', value: 'front' }]),
      },
      { id: 'anthropic-api' },
    ])

    expect((await implementer.run(ctx(undefined, { repo: 'back' }))).provider).toBe('anthropic-api')
    expect((await implementer.run(ctx(undefined, { repo: 'front' }))).provider).toBe('claude-tmux')
  })

  it('when every candidate is full, waits for the first slot that frees', async () => {
    let freeA!: () => void
    const a = provider('a', { maxConcurrent: 1 }, new Promise((r) => (freeA = r)))
    const b = provider('b', { maxConcurrent: 1 }, new Promise(() => {}))
    const registry = new ProviderRegistry().register(a.provider).register(b.provider)
    const implementer = agent(registry, [{ id: 'a' }, { id: 'b' }])
    const limits = new ConcurrencyLimits()

    void implementer.run(ctx(limits))
    void implementer.run(ctx(limits))
    await tick()
    let third: string | undefined
    void implementer.run(ctx(limits)).then((result) => {
      third = result.provider
    })
    await tick()
    expect(third).toBeUndefined()

    freeA()
    await tick()
    await tick()
    expect(third).toBe('a')
  })

  it('no eligible candidate is an error that says why', async () => {
    const registry = new ProviderRegistry().register(provider('a').provider)
    const implementer = agent(registry, [
      { id: 'a', when: Condition.fromRows([{ field: 'x', op: 'eq', value: 1 }]) },
    ])
    await expect(implementer.run(ctx())).rejects.toThrow(/ningún provider es elegible/)
  })

  it('declaring both provider and providers, or neither, is a definition error', () => {
    const registry = new ProviderRegistry()
    expect(
      () => new Agent({ id: 'x', prompt: 'p', provider: 'a', providers: [{ id: 'b' }] }, registry),
    ).toThrow(/no los dos/)
    expect(() => new Agent({ id: 'x', prompt: 'p' }, registry)).toThrow(/falta `provider`/)
  })

  it('a resumed conversation continues in the provider that built it', async () => {
    const tmux = provider('claude-tmux')
    const api = provider('anthropic-api')
    const registry = new ProviderRegistry().register(tmux.provider).register(api.provider)
    const implementer = agent(registry, [{ id: 'claude-tmux' }, { id: 'anthropic-api' }])

    await implementer.run({
      ...ctx(),
      resume: {
        step: 'implementer',
        branch: 'event',
        event: createEvent('ci', {}),
        state: { provider: 'anthropic-api', conversation: { sessionId: 's' } },
      },
    })

    expect(tmux.runs).toEqual([])
    expect(api.runs[0]?.resume?.conversation).toEqual({ sessionId: 's' })
  })

  describe('a wildcard (remote:*)', () => {
    it('expands to the registered providers it covers, in order, with its config; the next candidate is the fallback', async () => {
      const a = provider('remote:a', {
        canAccept: async () => ({ accept: false, reason: 'lleno', retryAfterMs: 5 }),
      })
      const b = provider('remote:b')
      const api = provider('anthropic-api')
      const registry = new ProviderRegistry()
        .register(a.provider)
        .register(api.provider)
        .register(b.provider)
      const implementer = agent(registry, [
        { id: 'remote:*', config: { model: 'opus' } },
        { id: 'anthropic-api' },
      ])

      const result = await implementer.run(ctx())

      expect(result.provider).toBe('remote:b')
      expect(b.runs[0]?.providerConfig).toEqual({ model: 'opus' })
      expect(api.runs).toEqual([])
    })

    it('with none registered, falls to the next candidate', async () => {
      const api = provider('anthropic-api')
      const registry = new ProviderRegistry().register(api.provider)
      const result = await agent(registry, [{ id: 'remote:*' }, { id: 'anthropic-api' }]).run(ctx())
      expect(result.provider).toBe('anthropic-api')
    })

    it('alone and with none registered, waits until one registers', async () => {
      const registry = new ProviderRegistry()
      let chosen: string | undefined
      void agent(registry, [{ id: 'remote:*' }])
        .run(ctx())
        .then((result) => {
          chosen = result.provider
        })
      await tick()
      expect(chosen).toBeUndefined()

      registry.register(provider('remote:laptop').provider)
      await tick()
      await tick()
      expect(chosen).toBe('remote:laptop')
    })

    it('a provider that unregisters stops being a candidate', async () => {
      const registry = new ProviderRegistry()
        .register(provider('remote:gone').provider)
        .register(provider('remote:here').provider)
      registry.unregister('remote:gone')
      const result = await agent(registry, [{ id: 'remote:*' }]).run(ctx())
      expect(result.provider).toBe('remote:here')
      expect(registry.list().map((p) => p.id)).toEqual(['remote:here'])
    })
  })

  describe('a named dynamic provider (remote:e2e)', () => {
    it('alone and not registered yet, waits until its host registers', async () => {
      const registry = new ProviderRegistry().expectDynamic('remote:')
      let chosen: string | undefined
      void agent(registry, [{ id: 'remote:e2e' }])
        .run(ctx())
        .then((result) => {
          chosen = result.provider
        })
      await tick()
      expect(chosen).toBeUndefined()

      registry.register(provider('remote:other').provider)
      await tick()
      await tick()
      expect(chosen).toBeUndefined()

      registry.register(provider('remote:e2e').provider)
      await tick()
      await tick()
      expect(chosen).toBe('remote:e2e')
    })

    it('a resumed conversation waits for its host instead of failing', async () => {
      const registry = new ProviderRegistry().expectDynamic('remote:')
      let chosen: string | undefined
      void agent(registry, [{ id: 'remote:e2e' }])
        .run({
          ...ctx(),
          resume: {
            step: 'implementer',
            branch: 'event',
            event: createEvent('ci', {}),
            state: { provider: 'remote:e2e', conversation: { sessionId: 's' } },
          },
        })
        .then((result) => {
          chosen = result.provider
        })
      await tick()
      expect(chosen).toBeUndefined()

      registry.register(provider('remote:e2e').provider)
      await tick()
      await tick()
      expect(chosen).toBe('remote:e2e')
    })

    it('not registered, falls to the next candidate', async () => {
      const api = provider('anthropic-api')
      const registry = new ProviderRegistry().expectDynamic('remote:').register(api.provider)
      const result = await agent(registry, [{ id: 'remote:e2e' }, { id: 'anthropic-api' }]).run(
        ctx(),
      )
      expect(result.provider).toBe('anthropic-api')
    })

    it('an unknown id outside the dynamic prefixes is still an error', async () => {
      const registry = new ProviderRegistry().expectDynamic('remote:')
      await expect(agent(registry, [{ id: 'claude-typo' }]).run(ctx())).rejects.toThrow(
        /provider desconocido "claude-typo"/,
      )
    })
  })
})
