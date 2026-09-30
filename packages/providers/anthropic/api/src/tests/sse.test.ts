import { describe, expect, it, vi } from 'vitest'
import type { AnthropicStreamDelta } from '../sse.js'
import { readAnthropicSseStream } from '../sse.js'

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
  return new Response(body)
}

function frame(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
}

describe('readAnthropicSseStream', () => {
  it('reassembles a text response from message_start/content_block_*/message_delta', async () => {
    const res = sseResponse([
      frame('message_start', { message: { id: 'msg_1', usage: { input_tokens: 5 } } }),
      frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hola ' } }),
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'mundo' } }),
      frame('content_block_stop', { index: 0 }),
      frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }),
      frame('message_stop', {}),
    ])

    const message = await readAnthropicSseStream(res)

    expect(message.stop_reason).toBe('end_turn')
    expect(message.content).toEqual([{ type: 'text', text: 'Hola mundo' }])
    expect(message.usage).toEqual({ input_tokens: 5, output_tokens: 3 })
  })

  it('reassembles a tool_use block from streamed input_json_delta', async () => {
    const res = sseResponse([
      frame('message_start', { message: {} }),
      frame('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'search', input: {} },
      }),
      frame('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"q":' },
      }),
      frame('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"x"}' },
      }),
      frame('content_block_stop', { index: 0 }),
      frame('message_delta', { delta: { stop_reason: 'tool_use' } }),
    ])

    const message = await readAnthropicSseStream(res)

    expect(message.content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'x' } },
    ])
  })

  it('falls back to an empty object when the streamed tool input JSON is malformed', async () => {
    const res = sseResponse([
      frame('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'x', input: {} },
      }),
      frame('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{not json' },
      }),
      frame('content_block_stop', { index: 0 }),
    ])

    const message = await readAnthropicSseStream(res)

    expect((message.content as Array<Record<string, unknown>>)[0].input).toEqual({})
  })

  it('calls onDelta with each text_delta fragment as it arrives, not the accumulated text', async () => {
    const res = sseResponse([
      frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hola ' } }),
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'mundo' } }),
      frame('content_block_stop', { index: 0 }),
      frame('message_delta', { delta: { stop_reason: 'end_turn' } }),
    ])
    const onDelta = vi.fn()

    await readAnthropicSseStream(res, onDelta)

    expect(onDelta.mock.calls.map((call) => call[0])).toEqual<AnthropicStreamDelta[]>([
      { index: 0, type: 'text', delta: 'Hola ' },
      { index: 0, type: 'text', delta: 'mundo' },
    ])
  })

  it('calls onDelta for thinking_delta too, and never for input_json_delta/signature_delta', async () => {
    const res = sseResponse([
      frame('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      frame('content_block_delta', {
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'razonando' },
      }),
      frame('content_block_delta', {
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig' },
      }),
      frame('content_block_stop', { index: 0 }),
      frame('content_block_start', {
        index: 1,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'x', input: {} },
      }),
      frame('content_block_delta', {
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      }),
      frame('content_block_stop', { index: 1 }),
      frame('message_delta', { delta: { stop_reason: 'tool_use' } }),
    ])
    const onDelta = vi.fn()

    await readAnthropicSseStream(res, onDelta)

    expect(onDelta).toHaveBeenCalledTimes(1)
    expect(onDelta).toHaveBeenCalledWith({ index: 0, type: 'thinking', delta: 'razonando' })
  })

  it('reassembles the same final response whether or not onDelta is passed', async () => {
    const frames = [
      frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      frame('content_block_stop', { index: 0 }),
      frame('message_delta', { delta: { stop_reason: 'end_turn' } }),
    ]

    const withoutHandler = await readAnthropicSseStream(sseResponse(frames))
    const withHandler = await readAnthropicSseStream(sseResponse(frames), vi.fn())

    expect(withHandler).toEqual(withoutHandler)
  })

  it('throws on an `error` SSE event', async () => {
    const res = sseResponse([frame('error', { error: { message: 'overloaded' } })])

    await expect(readAnthropicSseStream(res)).rejects.toThrow('overloaded')
  })

  it('propagates an onDelta error and still releases the reader instead of leaking the stream', async () => {
    const res = sseResponse([
      frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hola' } }),
      frame('content_block_stop', { index: 0 }),
      frame('message_delta', { delta: { stop_reason: 'end_turn' } }),
    ])
    const onDelta = () => {
      throw new Error('caller boom')
    }

    await expect(readAnthropicSseStream(res, onDelta)).rejects.toThrow('caller boom')
    // Si el reader no se hubiera liberado, `res.body` seguiría bloqueado para siempre.
    expect(res.body?.locked).toBe(false)
  })

  it('throws when the response has no body', async () => {
    const res = new Response(null)
    // `new Response(null)` still gives a body in some runtimes — force the case explicitly.
    Object.defineProperty(res, 'body', { value: null })

    await expect(readAnthropicSseStream(res)).rejects.toThrow('sin body')
  })
})
