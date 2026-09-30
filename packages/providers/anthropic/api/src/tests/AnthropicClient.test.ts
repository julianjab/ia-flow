import { describe, expect, it, vi } from 'vitest'
import { AnthropicClient, backoffMs } from '../AnthropicClient.js'

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

describe('AnthropicClient.send', () => {
  it('sends x-api-key auth and the given model/messages, non-streaming', async () => {
    let receivedInit: RequestInit | undefined
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      receivedInit = init
      return jsonResponse({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' })
    })

    const client = new AnthropicClient({
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const result = await client.send({ model: 'claude-x', messages: [] }, { stream: false })

    expect(result.stop_reason).toBe('end_turn')
    const headers = receivedInit?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test')
    expect(headers.Authorization).toBeUndefined()
    const body = JSON.parse(receivedInit?.body as string)
    expect(body).toMatchObject({ model: 'claude-x', stream: false })
  })

  it('prefers oauthToken over apiKey and sends a Bearer Authorization header', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ content: [], stop_reason: 'end_turn' }),
    )
    const client = new AnthropicClient({
      apiKey: 'sk-test',
      oauthToken: 'oauth-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.send({}, { stream: false })

    const init = fetchImpl.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer oauth-token')
    expect(headers['x-api-key']).toBeUndefined()
  })

  it('adds the oauth-2025-04-20 beta when authenticating with a Bearer token', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ content: [], stop_reason: 'end_turn' }),
    )
    const client = new AnthropicClient({
      oauthToken: 'oauth-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.send({}, { stream: false })

    const init = fetchImpl.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['anthropic-beta'].split(',')).toContain('oauth-2025-04-20')
  })

  it('an explicit apiKey wins over an ambient CLAUDE_CODE_OAUTH_TOKEN in the environment', async () => {
    const prevOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-oauth-token'

    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ content: [], stop_reason: 'end_turn' }),
    )
    const client = new AnthropicClient({
      apiKey: 'sk-explicit',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.send({}, { stream: false })

    const init = fetchImpl.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-explicit')
    expect(headers.Authorization).toBeUndefined()

    if (prevOauth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOauth
    // biome-ignore lint/performance/noDelete: needs a real unset, not the string "undefined"
    else delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  })

  it('falls back to the environment (oauth before apiKey) only when neither is passed explicitly', async () => {
    const prevOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    const prevKey = process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'env-oauth-token'
    process.env.ANTHROPIC_API_KEY = 'env-api-key'

    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ content: [], stop_reason: 'end_turn' }),
    )
    const client = new AnthropicClient({ fetchImpl: fetchImpl as unknown as typeof fetch })

    await client.send({}, { stream: false })

    const init = fetchImpl.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer env-oauth-token')

    if (prevOauth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOauth
    // biome-ignore lint/performance/noDelete: needs a real unset, not the string "undefined"
    else delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey
    // biome-ignore lint/performance/noDelete: needs a real unset, not the string "undefined"
    else delete process.env.ANTHROPIC_API_KEY
  })

  it('throws when neither apiKey nor oauthToken resolve (and env is unset)', async () => {
    const prevKey = process.env.ANTHROPIC_API_KEY
    const prevOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    // `= undefined` (biome's usual suggestion) sets the literal string "undefined" — still
    // truthy — instead of clearing the var; `delete` is the one that actually unsets it.
    // biome-ignore lint/performance/noDelete: needs a real unset, not the string "undefined"
    delete process.env.ANTHROPIC_API_KEY
    // biome-ignore lint/performance/noDelete: needs a real unset, not the string "undefined"
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN

    const client = new AnthropicClient({ fetchImpl: vi.fn() as unknown as typeof fetch })
    await expect(client.send({}, { stream: false })).rejects.toThrow('falta credencial')

    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey
    if (prevOauth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOauth
  })

  it('merges client-level and per-send betas into anthropic-beta', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ content: [], stop_reason: 'end_turn' }),
    )
    const client = new AnthropicClient({
      apiKey: 'sk',
      anthropicBeta: ['base-beta'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await client.send({}, { stream: false, extraBetas: ['extra-beta'] })

    const init = fetchImpl.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['anthropic-beta'].split(',')).toEqual(
      expect.arrayContaining(['base-beta', 'extra-beta']),
    )
  })

  it('throws with the response body on a non-retryable error status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'bad request' }, { status: 400 }))
    const client = new AnthropicClient({
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(client.send({}, { stream: false })).rejects.toThrow('400')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries a 429 and succeeds once retries are available', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      if (calls === 1) return jsonResponse({}, { status: 429, headers: { 'retry-after': '0' } })
      return jsonResponse({ content: [], stop_reason: 'end_turn' })
    })
    const onRetry = vi.fn()
    const client = new AnthropicClient({
      apiKey: 'sk',
      maxRetries: 1,
      onRetry,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await client.send({}, { stream: false })

    expect(result.stop_reason).toBe('end_turn')
    expect(calls).toBe(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('returns the last error response once retries are exhausted', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { status: 503 }))
    const client = new AnthropicClient({
      apiKey: 'sk',
      maxRetries: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(client.send({}, { stream: false })).rejects.toThrow('503')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries on a thrown network error and eventually rethrows once exhausted', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const client = new AnthropicClient({
      apiKey: 'sk',
      maxRetries: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(client.send({}, { stream: false })).rejects.toThrow('ECONNRESET')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('reassembles a streaming response through readAnthropicSseStream', async () => {
    const sseBody = [
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n',
    ].join('')
    const fetchImpl = vi.fn(async () => new Response(sseBody))
    const client = new AnthropicClient({
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await client.send({}, { stream: true })

    expect(result.stop_reason).toBe('end_turn')
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('forwards onDelta to the streaming reader so callers see fragments before the response resolves', async () => {
    const sseBody = [
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"Ho"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"la"}}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}\n\n',
    ].join('')
    const fetchImpl = vi.fn(async () => new Response(sseBody))
    const client = new AnthropicClient({
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const seenBeforeResolve: string[] = []
    const onDelta = vi.fn((delta: { delta: string }) => {
      seenBeforeResolve.push(delta.delta)
    })

    const result = await client.send({}, { stream: true, onDelta })

    expect(seenBeforeResolve).toEqual(['Ho', 'la'])
    expect(result.content).toEqual([{ type: 'text', text: 'Hola' }])
  })

  it('ignores onDelta when stream is false — there is no SSE to read deltas from', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    )
    const client = new AnthropicClient({
      apiKey: 'sk',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const onDelta = vi.fn()

    await client.send({}, { stream: false, onDelta })

    expect(onDelta).not.toHaveBeenCalled()
  })
})

describe('backoffMs', () => {
  it('honors retry-after (seconds) over the exponential schedule', () => {
    expect(backoffMs(0, '2')).toBe(2000)
  })

  it('caps retry-after at 60s', () => {
    expect(backoffMs(0, '9999')).toBe(60_000)
  })

  it('ignores a non-numeric retry-after and falls back to exponential backoff', () => {
    const delay = backoffMs(0, 'not-a-number')
    expect(delay).toBeGreaterThanOrEqual(250)
    expect(delay).toBeLessThan(500)
  })
})
