import { describe, expect, it, vi } from 'vitest'
import {
  AnthropicClient,
  AnthropicStreamError,
  isRetryableStreamError,
} from '../AnthropicClient.js'

/** Un 200 con un stream SSE armado con `frames` ([evento, data]). */
function sseResponse(frames: Array<[string, unknown]>): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const [event, data] of frames) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const overloaded: Array<[string, unknown]> = [
  ['message_start', { message: { id: 'msg_1', usage: { input_tokens: 3 } } }],
  ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
]

const ok: Array<[string, unknown]> = [
  ['message_start', { message: { id: 'msg_2', usage: { input_tokens: 3 } } }],
  ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hola' } }],
  ['content_block_stop', { index: 0 }],
  ['message_delta', { delta: { stop_reason: 'end_turn' } }],
  ['message_stop', {}],
]

function clientOf(responses: Array<Array<[string, unknown]>>, maxRetries = 2) {
  const fetchImpl = vi.fn(async () => sseResponse(responses.shift() ?? ok))
  const onRetry = vi.fn()
  const client = new AnthropicClient({
    apiKey: 'sk',
    maxRetries,
    onRetry,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { client, fetchImpl, onRetry }
}

describe('un error del upstream en medio del stream', () => {
  it('overloaded_error antes de cualquier contenido: se reintenta y devuelve la respuesta buena', async () => {
    const { client, fetchImpl, onRetry } = clientOf([overloaded])
    const deltas: string[] = []

    const result = await client.send({}, { onDelta: (d) => deltas.push(d.delta) })

    expect(result.stop_reason).toBe('end_turn')
    expect(result.id).toBe('msg_2')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(deltas).toEqual(['Hola'])
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 2,
        maxRetries: 2,
        error: expect.any(AnthropicStreamError),
      }),
    )
  })

  it('agotados los reintentos, tira el error del stream con su tipo', async () => {
    const { client, fetchImpl } = clientOf([overloaded, overloaded], 1)

    const err = await client.send({}).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(AnthropicStreamError)
    expect((err as AnthropicStreamError).errorType).toBe('overloaded_error')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('con contenido ya emitido no se reintenta: el caller ya vio parte de la respuesta', async () => {
    const midway: Array<[string, unknown]> = [
      ...ok.slice(0, 3),
      ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
    ]
    const { client, fetchImpl } = clientOf([midway])
    const deltas: string[] = []

    const err = await client.send({}, { onDelta: (d) => deltas.push(d.delta) }).catch((e) => e)

    expect((err as AnthropicStreamError).emitted).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(deltas).toEqual(['Hola'])
  })

  it('un error del request (invalid_request_error) no se reintenta', async () => {
    const invalid: Array<[string, unknown]> = [
      ['error', { type: 'error', error: { type: 'invalid_request_error', message: 'nope' } }],
    ]
    const { client, fetchImpl } = clientOf([invalid])

    await expect(client.send({})).rejects.toThrow('invalid_request_error')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('sin reintentos configurados, tira al primero', async () => {
    const { client, fetchImpl } = clientOf([overloaded], 0)

    await expect(client.send({})).rejects.toThrow('overloaded_error')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('isRetryableStreamError', () => {
  it('sólo los errores del upstream de un stream sin contenido', () => {
    expect(
      isRetryableStreamError(new AnthropicStreamError({ type: 'overloaded_error' }, false)),
    ).toBe(true)
    expect(isRetryableStreamError(new AnthropicStreamError({ type: 'api_error' }, false))).toBe(
      true,
    )
    expect(
      isRetryableStreamError(new AnthropicStreamError({ type: 'overloaded_error' }, true)),
    ).toBe(false)
    expect(
      isRetryableStreamError(new AnthropicStreamError({ type: 'invalid_request_error' }, false)),
    ).toBe(false)
    expect(isRetryableStreamError(new Error('overloaded_error'))).toBe(false)
  })
})
