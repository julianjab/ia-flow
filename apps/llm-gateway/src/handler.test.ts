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

describe('x-api-key', () => {
  const handler = setup(async () => reply)
  const withKey = (key: string) =>
    handler(new Request('http://gateway.test/v1/models', { headers: { 'x-api-key': key } }))

  test('acepta el token del gateway como x-api-key', async () => {
    expect((await withKey(TOKEN)).status).toBe(200)
  })

  test('rechaza un x-api-key que no es el token', async () => {
    expect((await withKey('otro')).status).toBe(401)
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

describe('systemPrompt', () => {
  const sent: Record<string, unknown>[] = []
  const handler = createHandler({
    config: { ...config, systemPrompt: 'prompt del gateway' },
    send: async (body) => {
      sent.push(body)
      return reply
    },
  })

  test('va como primer system, antes del que manda el cliente', async () => {
    sent.length = 0
    await call(
      handler,
      '/v1/chat/completions',
      post({
        messages: [
          { role: 'system', content: 'de iterm' },
          { role: 'user', content: 'hola' },
        ],
      }),
    )
    expect(sent[0]?.system).toBe('prompt del gateway\n\nde iterm')
  })

  test('sin system del cliente, es el único', async () => {
    sent.length = 0
    await call(
      handler,
      '/v1/chat/completions',
      post({ messages: [{ role: 'user', content: 'hola' }] }),
    )
    expect(sent[0]?.system).toBe('prompt del gateway')
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

  test('con logBody imprime también el body traducido, con el system prompt del gateway', async () => {
    lines.length = 0
    const handler = createHandler({
      config: { ...config, logBody: true, systemPrompt: 'prompt del gateway' },
      send: async () => reply,
      log,
    })
    await call(
      handler,
      '/v1/chat/completions',
      post({
        messages: [
          { role: 'system', content: 'de iterm' },
          { role: 'user', content: 'x' },
        ],
      }),
    )
    const out = lines.find((line) => line.startsWith('body hacia Anthropic: '))
    expect(out).toBeDefined()
    expect(JSON.parse(String(out).replace('body hacia Anthropic: ', '')).system).toBe(
      'prompt del gateway\n\nde iterm',
    )
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

describe('protocolo de Anthropic', () => {
  const ANTHROPIC_HEADERS = { 'x-api-key': TOKEN, 'anthropic-version': '2023-06-01' }
  const sse = 'event: message_start\ndata: {"type":"message_start"}\n\n'
  const forwarded: Record<string, unknown>[] = []
  const build = (upstream: () => Response, withForward = true) =>
    createHandler({
      config: { ...config, systemPrompt: 'del gateway' },
      send: async () => reply,
      forward: withForward
        ? async (body) => {
            forwarded.push(body)
            return upstream()
          }
        : undefined,
    })
  const anthropicCall = (
    handler: ReturnType<typeof build>,
    headers: Record<string, string> = ANTHROPIC_HEADERS,
  ) =>
    handler(
      new Request('http://gateway.test/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'claude-x',
          stream: true,
          system: 'de iterm',
          messages: [{ role: 'user', content: 'hola' }],
        }),
      }),
    )

  test('reenvía el body con el system del gateway primero y devuelve el SSE tal cual', async () => {
    forwarded.length = 0
    const handler = build(
      () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }),
    )
    const res = await anthropicCall(handler)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await res.text()).toBe(sse)
    expect(forwarded[0]).toMatchObject({
      model: 'claude-x',
      system: [
        { type: 'text', text: 'del gateway' },
        { type: 'text', text: 'de iterm' },
      ],
    })
    expect(JSON.stringify(forwarded[0])).not.toContain(TOKEN)
  })

  test('un token inválido responde con la forma de error de Anthropic', async () => {
    const res = await anthropicCall(
      build(() => new Response('')),
      { 'x-api-key': 'otro', 'anthropic-version': '2023-06-01' },
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: 'token inválido' },
    })
  })

  test('un 401 de Anthropic no se le muestra al cliente como suyo: sale 502', async () => {
    const upstream = { type: 'error', error: { type: 'authentication_error', message: 'x' } }
    const res = await anthropicCall(
      build(
        () =>
          new Response(JSON.stringify(upstream), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual(upstream)
  })

  test('sin puerto de reenvío falla con 502 en formato Anthropic', async () => {
    const res = await anthropicCall(build(() => new Response(''), false))
    expect(res.status).toBe(502)
    expect(((await res.json()) as { type: string }).type).toBe('error')
  })
})
