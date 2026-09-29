import { describe, expect, it } from 'vitest'
import { ProviderRegistry } from '../Provider.js'

describe('ProviderRegistry', () => {
  it('resolves a registered provider by id', () => {
    const registry = new ProviderRegistry()
    const provider = { id: 'a', run: async () => ({ outcome: 'success' }) }

    registry.register(provider)

    expect(registry.resolve('a')).toBe(provider)
  })

  it('returns undefined for an unknown id', () => {
    const registry = new ProviderRegistry()
    expect(registry.resolve('missing')).toBeUndefined()
  })

  it('register returns `this` so calls can chain', () => {
    const registry = new ProviderRegistry()
    const result = registry
      .register({ id: 'a', run: async () => ({ outcome: 'success' }) })
      .register({ id: 'b', run: async () => ({ outcome: 'success' }) })

    expect(result).toBe(registry)
    expect(registry.resolve('a')).toBeDefined()
    expect(registry.resolve('b')).toBeDefined()
  })

  it('registering the same id twice overwrites the previous provider', () => {
    const registry = new ProviderRegistry()
    registry.register({ id: 'a', run: async () => ({ outcome: 'first' }) })
    const second = { id: 'a', run: async () => ({ outcome: 'second' }) }
    registry.register(second)

    expect(registry.resolve('a')).toBe(second)
  })
})
