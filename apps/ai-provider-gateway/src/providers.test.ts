import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createProvider } from './providers.js'

const originalGatewayProvider = Bun.env.GATEWAY_PROVIDER

beforeEach(() => {
  delete Bun.env.GATEWAY_PROVIDER
})

afterEach(() => {
  if (originalGatewayProvider === undefined) delete Bun.env.GATEWAY_PROVIDER
  else Bun.env.GATEWAY_PROVIDER = originalGatewayProvider
})

describe('createProvider', () => {
  it('sin GATEWAY_PROVIDER seteado, resuelve anthropic-api por default', () => {
    const provider = createProvider()
    expect(provider.id).toBe('anthropic-api')
    expect(provider.kind).toBe('sync')
  })

  it('GATEWAY_PROVIDER=claude-print resuelve claude-print', () => {
    Bun.env.GATEWAY_PROVIDER = 'claude-print'
    const provider = createProvider()
    expect(provider.id).toBe('claude-print')
    expect(provider.kind).toBe('sync')
  })

  it('GATEWAY_PROVIDER con un valor desconocido cae al default (anthropic-api)', () => {
    Bun.env.GATEWAY_PROVIDER = 'algo-que-no-existe'
    const provider = createProvider()
    expect(provider.id).toBe('anthropic-api')
  })
})
