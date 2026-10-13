import { describe, expect, test } from 'bun:test'
import { BadRequestError, toAnthropicRequest } from './openaiToAnthropic.js'
import type { ChatCompletionRequest } from './openaiTypes.js'

const defaults = { model: 'claude-default', maxTokens: 4096 }
const translate = (request: ChatCompletionRequest) => toAnthropicRequest(request, defaults)

describe('toAnthropicRequest', () => {
  test('saca los system a `system` y aplica los defaults de modelo y max_tokens', () => {
    const body = translate({
      messages: [
        { role: 'system', content: 'sé breve' },
        { role: 'developer', content: 'en español' },
        { role: 'user', content: 'hola' },
      ],
    })
    expect(body.system).toBe('sé breve\n\nen español')
    expect(body.model).toBe('claude-default')
    expect(body.max_tokens).toBe(4096)
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hola' }] }])
  })

  test('max_completion_tokens gana sobre max_tokens', () => {
    const body = translate({
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 10,
      max_completion_tokens: 20,
    })
    expect(body.max_tokens).toBe(20)
  })

  test('temperature gana sobre top_p y stop se vuelve stop_sequences', () => {
    const both = translate({
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.2,
      top_p: 0.9,
      stop: 'FIN',
    })
    expect(both.temperature).toBe(0.2)
    expect(both.top_p).toBeUndefined()
    expect(both.stop_sequences).toEqual(['FIN'])
    const onlyTopP = translate({ messages: [{ role: 'user', content: 'x' }], top_p: 0.9 })
    expect(onlyTopP.top_p).toBe(0.9)
  })

  test('los opcionales en null se omiten y temperature se recorta a 1', () => {
    const nulls = translate({
      messages: [{ role: 'user', content: 'x' }],
      temperature: null,
      top_p: null,
      tool_choice: null,
      stop: null,
      tools: null,
    } as unknown as ChatCompletionRequest)
    for (const key of ['temperature', 'top_p', 'tool_choice', 'stop_sequences', 'tools']) {
      expect(key in nulls).toBe(false)
    }
    const hot = translate({ messages: [{ role: 'user', content: 'x' }], temperature: 1.5 })
    expect(hot.temperature).toBe(1)
  })

  test('traduce imágenes: data URL a base64 y URL tal cual', () => {
    const body = translate({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'image_url', image_url: { url: 'https://x.test/a.png' } },
          ],
        },
      ],
    })
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } },
        ],
      },
    ])
  })

  test('tool_calls y resultados de tools: tool_use, y los tool_result abren el turno de usuario', () => {
    const body = translate({
      messages: [
        { role: 'user', content: 'clima?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'clima', arguments: '{"c":"Bogotá"}' },
            },
            { id: 'call_2', type: 'function', function: { name: 'hora', arguments: '' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '18°' },
        { role: 'tool', tool_call_id: 'call_2', content: '10:00' },
        { role: 'user', content: 'gracias' },
      ],
    })
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'clima?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'clima', input: { c: 'Bogotá' } },
          { type: 'tool_use', id: 'call_2', name: 'hora', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '18°' },
          { type: 'tool_result', tool_use_id: 'call_2', content: '10:00' },
          { type: 'text', text: 'gracias' },
        ],
      },
    ])
  })

  test('tools y tool_choice', () => {
    const tools = [
      {
        type: 'function' as const,
        function: { name: 'f', description: 'd', parameters: { type: 'object' } },
      },
    ]
    const messages = [{ role: 'user' as const, content: 'x' }]
    expect(translate({ messages, tools }).tools).toEqual([
      { name: 'f', description: 'd', input_schema: { type: 'object' } },
    ])
    expect(translate({ messages, tools, tool_choice: 'required' }).tool_choice).toEqual({
      type: 'any',
    })
    expect(
      translate({ messages, tools, tool_choice: { type: 'function', function: { name: 'f' } } })
        .tool_choice,
    ).toEqual({ type: 'tool', name: 'f' })
    // 'none' conserva las tools: el historial puede traer tool_use y Anthropic exige su definición.
    const none = translate({ messages, tools, tool_choice: 'none' })
    expect(none.tools).toHaveLength(1)
    expect(none.tool_choice).toEqual({ type: 'none' })
  })

  test('rechaza lo que no puede traducir', () => {
    expect(() => translate({ messages: [] })).toThrow(BadRequestError)
    expect(() => translate({ messages: [{ role: 'system', content: 'solo system' }] })).toThrow(
      BadRequestError,
    )
    expect(() =>
      translate({
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              { id: 'c', type: 'function', function: { name: 'f', arguments: '{roto' } },
            ],
          },
        ],
      }),
    ).toThrow('no es JSON válido')
  })
})
