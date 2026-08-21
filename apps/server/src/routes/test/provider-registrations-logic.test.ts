import { afterEach, describe, expect, it } from 'bun:test'
import type { ProviderRegistration } from '../../domain/ports/IProviderRegistrationRepository.js'
import {
  RegistrationInputSchema,
  duplicateNameError,
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
      name: 'mi-gateway',
      baseUrl: 'https://gateway.example.com',
      token: 'secret',
    })
    expect(result.success).toBe(true)
  })

  it('rechaza name con espacios o mayúsculas (deja de ser un slug válido)', () => {
    const result = RegistrationInputSchema.safeParse({
      name: 'mi gateway',
      baseUrl: 'https://gateway.example.com',
      token: 'secret',
    })
    expect(result.success).toBe(false)
  })

  it('rechaza baseUrl que no es una URL', () => {
    const result = RegistrationInputSchema.safeParse({
      name: 'x',
      baseUrl: 'no-es-url',
      token: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('rechaza campos vacíos', () => {
    const result = RegistrationInputSchema.safeParse({
      name: '',
      baseUrl: 'https://x.com',
      token: 'x',
    })
    expect(result.success).toBe(false)
  })
})

describe('duplicateNameError', () => {
  it('null cuando el name no está en uso', () => {
    expect(duplicateNameError('julianbuitrago-mac', new Set())).toBeNull()
    expect(duplicateNameError('julianbuitrago-mac', new Set(['otro-nombre']))).toBeNull()
  })

  it('mensaje de error cuando el name ya existe', () => {
    const err = duplicateNameError('julianbuitrago-mac', new Set(['julianbuitrago-mac']))
    expect(err).toContain("'julianbuitrago-mac'")
    expect(err).toContain('already exists')
  })
})

describe('fetchGatewayProvider', () => {
  it('devuelve la entry cuando el gateway responde', async () => {
    let capturedUrl: string | undefined
    let capturedHeaders: Record<string, string> | undefined
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url
      capturedHeaders = init.headers as Record<string, string>
      return new Response(
        JSON.stringify({ kind: 'sync', name: 'Claude Print', description: 'x' }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const result = await fetchGatewayProvider('https://gw.example.com', 'tok')

    expect(capturedUrl).toBe('https://gw.example.com/v1/provider')
    expect(capturedHeaders?.authorization).toBe('Bearer tok')
    expect(result).toEqual({
      ok: true,
      entry: { kind: 'sync', name: 'Claude Print', description: 'x' },
    })
  })

  it('fetch tira (network error) → ok:false con el motivo', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const result = await fetchGatewayProvider('https://gw.example.com', 'tok')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('no se pudo alcanzar')
  })

  it('respuesta no-2xx → ok:false', async () => {
    globalThis.fetch = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch

    const result = await fetchGatewayProvider('https://gw.example.com', 'tok')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('500')
  })

  it('body de la respuesta no es un provider válido → ok:false', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ foo: 'bar' }), { status: 200 })) as unknown as typeof fetch

    const result = await fetchGatewayProvider('https://gw.example.com', 'tok')
    expect(result.ok).toBe(false)
  })

  it('body de la respuesta no es JSON válido → ok:false (no lanza)', async () => {
    globalThis.fetch = (async () =>
      new Response('no es json', { status: 200 })) as unknown as typeof fetch

    const result = await fetchGatewayProvider('https://gw.example.com', 'tok')
    expect(result.ok).toBe(false)
  })
})

describe('toPublicRegistration', () => {
  function registration(overrides: Partial<ProviderRegistration> = {}): ProviderRegistration {
    return {
      id: 'reg-1',
      name: 'mi-gateway',
      baseUrl: 'https://gw.example.com',
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
    expect(pub.name).toBe('mi-gateway')
    expect(pub.remoteName).toBe('Claude Print')
  })
})
