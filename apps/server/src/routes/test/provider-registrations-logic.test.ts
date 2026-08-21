import { afterEach, describe, expect, it } from 'bun:test'
import type { ProviderRegistration } from '../../domain/ports/IProviderRegistrationRepository.js'
import {
  RegistrationInputSchema,
  fetchGatewayProvider,
  toPublicRegistration,
} from '../provider-registrations-logic.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('RegistrationInputSchema', () => {
  it('acepta un body válido', () => {
    const result = RegistrationInputSchema.safeParse({
      name: 'mi gateway',
      baseUrl: 'https://gateway.example.com',
      providerId: 'claude-print',
      token: 'secret',
    })
    expect(result.success).toBe(true)
  })

  it('rechaza baseUrl que no es una URL', () => {
    const result = RegistrationInputSchema.safeParse({
      name: 'x',
      baseUrl: 'no-es-url',
      providerId: 'x',
      token: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('rechaza campos vacíos', () => {
    const result = RegistrationInputSchema.safeParse({
      name: '',
      baseUrl: 'https://x.com',
      providerId: 'x',
      token: 'x',
    })
    expect(result.success).toBe(false)
  })
})

describe('fetchGatewayProvider', () => {
  it('devuelve la entry cuando el gateway la expone', async () => {
    let capturedUrl: string | undefined
    let capturedHeaders: Record<string, string> | undefined
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url
      capturedHeaders = init.headers as Record<string, string>
      return new Response(
        JSON.stringify({
          providers: [{ id: 'claude-print', kind: 'sync', name: 'Claude Print', description: 'x' }],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const result = await fetchGatewayProvider('https://gw.example.com', 'tok', 'claude-print')

    expect(capturedUrl).toBe('https://gw.example.com/v1/providers')
    expect(capturedHeaders?.authorization).toBe('Bearer tok')
    expect(result).toEqual({
      ok: true,
      entry: { id: 'claude-print', kind: 'sync', name: 'Claude Print', description: 'x' },
    })
  })

  it('fetch tira (network error) → ok:false con el motivo', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const result = await fetchGatewayProvider('https://gw.example.com', 'tok', 'claude-print')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('no se pudo alcanzar')
  })

  it('respuesta no-2xx → ok:false', async () => {
    globalThis.fetch = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch

    const result = await fetchGatewayProvider('https://gw.example.com', 'tok', 'claude-print')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('500')
  })

  it('providerId no está en el listado del gateway → ok:false', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ providers: [{ id: 'otro', kind: 'sync', name: 'x', description: 'x' }] }),
        {
          status: 200,
        },
      )) as unknown as typeof fetch

    const result = await fetchGatewayProvider('https://gw.example.com', 'tok', 'claude-print')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("'claude-print'")
  })

  it('body de la respuesta no es JSON válido → ok:false (no lanza)', async () => {
    globalThis.fetch = (async () =>
      new Response('no es json', { status: 200 })) as unknown as typeof fetch

    const result = await fetchGatewayProvider('https://gw.example.com', 'tok', 'claude-print')
    expect(result.ok).toBe(false)
  })
})

describe('toPublicRegistration', () => {
  function registration(overrides: Partial<ProviderRegistration> = {}): ProviderRegistration {
    return {
      id: 'reg-1',
      name: 'mi gateway',
      baseUrl: 'https://gw.example.com',
      remoteProviderId: 'claude-print',
      token: 'secret-token',
      remoteKind: 'sync',
      remoteName: 'Claude Print',
      remoteDescription: 'x',
      createdAt: '2026-01-01T00:00:00Z',
      ...overrides,
    }
  }

  it('nunca incluye el token crudo', () => {
    const pub = toPublicRegistration(registration())
    expect(pub).not.toHaveProperty('token')
  })

  it('hasToken:true cuando el token no está vacío', () => {
    expect(toPublicRegistration(registration()).hasToken).toBe(true)
  })

  it('hasToken:false cuando el token está vacío', () => {
    expect(toPublicRegistration(registration({ token: '' })).hasToken).toBe(false)
  })

  it('preserva el resto de los campos', () => {
    const pub = toPublicRegistration(registration())
    expect(pub.id).toBe('reg-1')
    expect(pub.name).toBe('mi gateway')
    expect(pub.remoteProviderId).toBe('claude-print')
  })
})
