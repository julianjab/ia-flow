import { describe, expect, it } from 'vitest'
import * as lib from '../index.js'

describe('package entrypoint', () => {
  it('exports the harness building blocks', () => {
    expect(lib.Condition).toBeDefined()
    expect(lib.Conditional).toBeDefined()
    expect(lib.EventBus).toBeDefined()
    expect(lib.createEvent).toBeTypeOf('function')
    expect(lib.deriveEvent).toBeTypeOf('function')
    expect(lib.Agent).toBeDefined()
    expect(lib.ProviderRegistry).toBeDefined()
    expect(lib.providerRegistry).toBeDefined()
    expect(lib.SchemaTool).toBeDefined()
    expect(lib.NO_TRANSITION_OUTCOMES).toBeInstanceOf(Set)
    expect(lib.Action).toBeDefined()
    expect(lib.resolveRoutes).toBeTypeOf('function')
    expect(lib.END).toBeTypeOf('symbol')
    expect(lib.EmitAction).toBeDefined()
    expect(lib.FunctionAction).toBeDefined()
    expect(lib.HttpAction).toBeDefined()
    expect(lib.Runnable).toBeDefined()
    expect(lib.Pipeline).toBeDefined()
    expect(lib.isAgent).toBeTypeOf('function')
    expect(lib.Engine).toBeDefined()
    expect(lib.DEFAULT_MAX_EVENT_DEPTH).toBe(10)
    expect(lib.StaticPipelineSource).toBeDefined()
  })

  it('wires end-to-end through the public API only', async () => {
    const registry = new lib.ProviderRegistry().register({
      id: 'echo-provider',
      run: async () => ({ outcome: 'success', summary: 'ok' }),
    })
    const pipeline = new lib.Pipeline({
      id: 'p',
      on: ['a'],
      do: [new lib.Agent({ id: 'echo', provider: 'echo-provider', prompt: 'p' }, registry)],
    })
    const bus = new lib.EventBus()
    const engine = new lib.Engine({
      bus,
      pipelines: new lib.StaticPipelineSource([pipeline]),
    })

    const outcome = await engine.dispatch(lib.createEvent('a', {}))

    expect(outcome).toBe('dispatched')
  })
})
