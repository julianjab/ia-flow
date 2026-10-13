import { describe, expect, test } from 'bun:test'
import type { AnthropicMessagesResponse } from '@ia-flow/provider-anthropic-api'
import { createHandler, type SendToAnthropic } from './handler.js'

const TOKEN = 'token-de-prueba-123456'
const config = {
  token: TOKEN,
  models: ['claude-a', 'claude-b'],
  defaultModel: 'claude-a',
  defaultMaxTokens: 1000,
}

const reply: AnthropicMessagesResponse = {
  content: [{ type: 'text', text: 'hola mundo' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 2 },
}

function setup(send: SendToAnthropic) {
  return createHandler({ config, send, now: () => 5000, newId: () => 'abc' })
}

const call = (
  handler: ReturnType<typeof setup>,
  path: string,
  init: RequestInit = {},
  auth = true,
) =>
  handler(
    new Request(`http://gateway.test${path}`, {
      ...init,
      headers: { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), ...init.headers },
    }),
  )

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })

describe('auth y rutas', () => {
  const handler = setup(async () => reply)

  test('/health no pide token; el resto sí', async () => {
    expect((await call(handler, '/health', {}, false)).status).toBe(200)
    expect((await call(handler, '/v1/models', {}, false)).status).toBe(401)
    const wrong = await handler(
      new Request('http://gateway.test/v1/models', { headers: { authorization: 'Bearer otro' } }),
    )
    expect(wrong.status).toBe(401)
  })

  test('lista los modelos configurados', async () => {
    const body = (await (await call(handler, '/v1/models')).json()) as { data: { id: string }[] }
    expect(body.data.map((m) => m.id)).toEqual(['claude-a', 'claude-b'])
  })

  test('404 en una ruta desconocida y 400 con un body que no es JSON', async () => {
    expect((await call(handler, '/v1/nada')).status).toBe(404)
    const res = await call(handler, '/v1/chat/completions', { method: 'POST', body: '{roto' })
    expect(res.status).toBe(400)
  })
})

describe('POST /v1/chat/completions', () => {
  test('sin stream: traduce el request, llama a Anthropic y devuelve un chat.completion', async () => {
    let sent: Record<string, unknown> | undefined
    const handler = setup(async (body, options) => {
      sent = body
      expect(options.stream).toBe(false)
      return reply
    })
    const res = await call(
      handler,
      '/v1/chat/completions',
      post({ messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(res.status).toBe(200)
    expect(sent?.model).toBe('claude-a')
    expect(sent?.max_tokens).toBe(1000)
    const body = (await res.json()) as {
      id: string
      created: number
      choices: { message: { content: string } }[]
    }
    expect(body.id).toBe('chatcmpl-abc')
    expect(body.created).toBe(5)
    expect(body.choices[0]?.message.content).toBe('hola mundo')
  })

  test('con stream: role, deltas de texto, finish_reason, usage y [DONE]', async () => {
    const handler = setup(async (_body, options) => {
      options.onDelta?.({ index: 0, type: 'thinking', delta: 'pensando' })
      options.onDelta?.({ index: 1, type: 'text', delta: 'ho' })
      options.onDelta?.({ index: 1, type: 'text', delta: 'la' })
      return reply
    })
    const res = await call(
      handler,
      '/v1/chat/completions',
      post({
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const frames = (await res.text())
      .split('\n\n')
      .filter(Boolean)
      .map((frame) => frame.replace(/^data: /, ''))
    expect(frames.at(-1)).toBe('[DONE]')
    const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame))
    expect(chunks[0].choices[0].delta.role).toBe('assistant')
    expect(chunks.flatMap((c) => c.choices.map((x: any) => x.delta?.content ?? '')).join('')).toBe(
      'hola',
    )
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('stop')
    expect(chunks.at(-1).usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })
  })

  test('con stream y tools: manda los tool_calls antes del cierre', async () => {
    const handler = setup(async () => ({
      content: [{ type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } }],
      stop_reason: 'tool_use',
    }))
    const res = await call(
      handler,
      '/v1/chat/completions',
      post({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    )
    const text = await res.text()
    expect(text).toContain('"tool_calls":[{"index":0,"id":"t1"')
    expect(text).toContain('"finish_reason":"tool_calls"')
  })

  test('un error de Anthropic en stream sale como frame de error y cierra con [DONE]', async () => {
    const handler = setup(async () => {
      throw new Error('upstream caído')
    })
    const res = await call(
      handler,
      '/v1/chat/completions',
      post({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    )
    const text = await res.text()
    expect(text).toContain('upstream caído')
    expect(text.trimEnd().endsWith('[DONE]')).toBe(true)
  })

  test('un error de Anthropic sin stream se traduce a status y body de OpenAI', async () => {
    const handler = setup(async () => {
      throw new Error('upstream caído')
    })
    const res = await call(
      handler,
      '/v1/chat/completions',
      post({ messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'upstream caído',
    )
  })
})

describe('logBody', () => {
  const lines: string[] = []
  const log = { info: (m: string) => lines.push(m), warn() {}, error() {} }
  const withBody = (logBody: boolean) =>
    createHandler({ config: { ...config, logBody }, send: async () => reply, log })

  test('con logBody imprime headers y body crudo, incluso sin auth o con body no JSON', async () => {
    lines.length = 0
    const handler = withBody(true)
    await call(
      handler,
      '/v1/chat/completions',
      post({ messages: [{ role: 'user', content: 'x' }] }),
    )
    await call(handler, '/v1/chat/completions', { method: 'POST', body: 'no-json' })
    await call(handler, '/v1/chat/completions', { method: 'POST', body: 'sin-auth' }, false)
    const dumps = lines.filter((line) => line.startsWith('request completo'))
    expect(dumps).toHaveLength(3)
    expect(dumps[0]).toContain(`authorization: Bearer ${TOKEN}`)
    expect(dumps[0]).toContain('"content":"x"')
    expect(dumps[1]).toContain('body: no-json')
    expect(dumps[2]).toContain('body: sin-auth')
  })

  test('sin logBody no imprime nada del body', async () => {
    lines.length = 0
    await call(
      withBody(false),
      '/v1/chat/completions',
      post({ messages: [{ role: 'user', content: 'secreto' }] }),
    )
    expect(lines.some((line) => line.includes('secreto'))).toBe(false)
  })
})
