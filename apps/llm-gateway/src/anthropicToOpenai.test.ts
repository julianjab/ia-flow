import { describe, expect, test } from 'bun:test'
import { AnthropicApiError } from '@ia-flow/provider-anthropic-api'
import { finishReason, toChatCompletion, toErrorResponse, usageOf } from './anthropicToOpenai.js'
import { BadRequestError } from './openaiToAnthropic.js'

const meta = { id: 'chatcmpl-1', model: 'claude-x', created: 100 }

describe('toChatCompletion', () => {
  test('texto: contenido, finish_reason y usage con tokens de cache', () => {
    const completion = toChatCompletion(
      {
        content: [
          { type: 'text', text: 'ho' },
          { type: 'text', text: 'la' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, cache_read_input_tokens: 3, output_tokens: 2 },
      },
      meta,
    )
    expect(completion.choices[0]?.message).toEqual({ role: 'assistant', content: 'hola' })
    expect(completion.choices[0]?.finish_reason).toBe('stop')
    expect(completion.usage).toEqual({ prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 })
  })

  test('tool_use: tool_calls con argumentos serializados y content null', () => {
    const completion = toChatCompletion(
      {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'clima', input: { c: 'x' } }],
        stop_reason: 'tool_use',
      },
      meta,
    )
    expect(completion.choices[0]?.message).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'toolu_1', type: 'function', function: { name: 'clima', arguments: '{"c":"x"}' } },
      ],
    })
    expect(completion.choices[0]?.finish_reason).toBe('tool_calls')
  })
})

describe('finishReason / usageOf', () => {
  test('mapea las razones de parada', () => {
    expect(finishReason('max_tokens')).toBe('length')
    expect(finishReason('refusal')).toBe('content_filter')
    expect(finishReason('stop_sequence')).toBe('stop')
    expect(finishReason(null)).toBe('stop')
  })

  test('usage ausente da ceros', () => {
    expect(usageOf({ content: [], stop_reason: null })).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    })
  })
})

describe('toErrorResponse', () => {
  const apiError = (status: number, type: string, message: string) =>
    new AnthropicApiError(status, JSON.stringify({ error: { type, message } }), undefined)

  test('400 de traducción', () => {
    expect(toErrorResponse(new BadRequestError('mal')).status).toBe(400)
  })

  test('credencial rechazada y rate limit', () => {
    expect(toErrorResponse(apiError(401, 'authentication_error', 'x')).status).toBe(502)
    const limited = toErrorResponse(apiError(429, 'rate_limit_error', 'lento'))
    expect(limited.status).toBe(429)
    expect(limited.body.error.code).toBe('rate_limit_exceeded')
  })

  test('4xx del upstream se conserva y un error cualquiera es 502', () => {
    expect(toErrorResponse(apiError(400, 'invalid_request_error', 'model')).status).toBe(400)
    expect(toErrorResponse(new Error('red caída')).status).toBe(502)
  })
})
