import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Task } from '@ia-flow/shared'
import { createProviderClassifier } from './provider-classifier.js'

const originalFetch = globalThis.fetch
const originalOauth = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
const originalApiKey = Bun.env.ANTHROPIC_API_KEY

beforeEach(() => {
  Bun.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token'
  delete Bun.env.ANTHROPIC_API_KEY
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalOauth === undefined) delete Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  else Bun.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauth
  if (originalApiKey === undefined) delete Bun.env.ANTHROPIC_API_KEY
  else Bun.env.ANTHROPIC_API_KEY = originalApiKey
})

function task(
  overrides: Partial<Pick<Task, 'title' | 'description' | 'type'>> = {},
): Pick<Task, 'title' | 'description' | 'type'> {
  return { title: 'Add login', description: 'desc', type: 'functional', ...overrides }
}

function warnLog() {
  const calls: Array<[object, string | undefined]> = []
  return { warn: (obj: object, msg?: string) => calls.push([obj, msg]), calls }
}

function toolUseResponse(providerId: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'tool_use', name: 'choose_provider', input: { providerId } }],
    }),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

describe('createProviderClassifier', () => {
  it('devuelve el providerId elegido por la tool call', async () => {
    let capturedBody: any
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return toolUseResponse('b')
    }) as unknown as typeof fetch

    const log = warnLog()
    const classify = createProviderClassifier({ log })
    const result = await classify({
      task: task(),
      candidates: [
        { providerId: 'a', whenText: 'simple' },
        { providerId: 'b', whenText: 'complejo' },
      ],
    })

    expect(result).toBe('b')
    expect(capturedBody.model).toBe('claude-haiku-4-5-20251001')
    expect(capturedBody.tool_choice).toEqual({ type: 'tool', name: 'choose_provider' })
    expect(capturedBody.tools[0].input_schema.properties.providerId.enum).toEqual(['a', 'b'])
    expect(log.calls.length).toBe(0)
  })

  it('sin auth configurada → null, sin llamar a fetch', async () => {
    delete Bun.env.CLAUDE_CODE_OAUTH_TOKEN
    delete Bun.env.ANTHROPIC_API_KEY
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      return toolUseResponse('a')
    }) as unknown as typeof fetch

    const log = warnLog()
    const classify = createProviderClassifier({ log })
    const result = await classify({ task: task(), candidates: [{ providerId: 'a' }] })

    expect(result).toBeNull()
    expect(fetchCalled).toBe(false)
    expect(log.calls.length).toBe(1)
  })

  it('respuesta no-2xx → null', async () => {
    globalThis.fetch = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch

    const log = warnLog()
    const classify = createProviderClassifier({ log })
    const result = await classify({
      task: task(),
      candidates: [{ providerId: 'a' }, { providerId: 'b' }],
    })

    expect(result).toBeNull()
    expect(log.calls.length).toBe(1)
  })

  it('la tool call no está en la respuesta → null', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'no elijo' }] }), {
        status: 200,
      })) as unknown as typeof fetch

    const log = warnLog()
    const classify = createProviderClassifier({ log })
    const result = await classify({
      task: task(),
      candidates: [{ providerId: 'a' }, { providerId: 'b' }],
    })

    expect(result).toBeNull()
  })

  it('la tool call elige un id fuera del set de candidatos → null', async () => {
    globalThis.fetch = (async () => toolUseResponse('c')) as unknown as typeof fetch

    const log = warnLog()
    const classify = createProviderClassifier({ log })
    const result = await classify({
      task: task(),
      candidates: [{ providerId: 'a' }, { providerId: 'b' }],
    })

    expect(result).toBeNull()
  })

  it('fetch tira (network error / timeout) → null, nunca lanza', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    const log = warnLog()
    const classify = createProviderClassifier({ log })
    const result = await classify({
      task: task(),
      candidates: [{ providerId: 'a' }, { providerId: 'b' }],
    })

    expect(result).toBeNull()
    expect(log.calls.length).toBe(1)
  })

  it('usa x-api-key cuando no hay oauth token', async () => {
    delete Bun.env.CLAUDE_CODE_OAUTH_TOKEN
    Bun.env.ANTHROPIC_API_KEY = 'sk-test'
    let capturedHeaders: Record<string, string> | undefined
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>
      return toolUseResponse('a')
    }) as unknown as typeof fetch

    const classify = createProviderClassifier({ log: warnLog() })
    await classify({ task: task(), candidates: [{ providerId: 'a' }] })

    expect(capturedHeaders?.['x-api-key']).toBe('sk-test')
  })
})
