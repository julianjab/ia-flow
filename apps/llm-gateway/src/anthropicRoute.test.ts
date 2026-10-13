import { describe, expect, test } from 'bun:test'
import { isAnthropicRequest, prepareAnthropicBody } from './anthropicRoute.js'
import { BadRequestError } from './openaiToAnthropic.js'

const defaults = { model: 'claude-default', maxTokens: 4096 }
const messages = [{ role: 'user', content: 'hola' }]

describe('prepareAnthropicBody', () => {
  test('aplica modelo y max_tokens por defecto sólo si faltan', () => {
    expect(prepareAnthropicBody({ messages }, defaults)).toMatchObject({
      model: 'claude-default',
      max_tokens: 4096,
    })
    expect(prepareAnthropicBody({ messages, model: 'm', max_tokens: 10 }, defaults)).toMatchObject({
      model: 'm',
      max_tokens: 10,
    })
  })

  test('el system prompt del gateway va primero, sea string, bloques o ausente', () => {
    const withPrompt = { ...defaults, systemPrompt: 'del gateway' }
    expect(prepareAnthropicBody({ messages, system: 'de iterm' }, withPrompt).system).toBe(
      'del gateway\n\nde iterm',
    )
    expect(
      prepareAnthropicBody({ messages, system: [{ type: 'text', text: 'bloque' }] }, withPrompt)
        .system,
    ).toEqual([
      { type: 'text', text: 'del gateway' },
      { type: 'text', text: 'bloque' },
    ])
    expect(prepareAnthropicBody({ messages }, withPrompt).system).toBe('del gateway')
  })

  test('sin system prompt no toca el system del cliente', () => {
    expect(prepareAnthropicBody({ messages, system: 'de iterm' }, defaults).system).toBe('de iterm')
    expect('system' in prepareAnthropicBody({ messages }, defaults)).toBe(false)
  })

  test('dropSampling quita temperature y top_p', () => {
    const body = prepareAnthropicBody(
      { messages, temperature: 0.2, top_p: 0.9, top_k: 5 },
      { ...defaults, dropSampling: true },
    )
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.top_k).toBe(5)
  })

  test('rechaza un body que no es objeto o no trae messages', () => {
    expect(() => prepareAnthropicBody('x', defaults)).toThrow(BadRequestError)
    expect(() => prepareAnthropicBody({ messages: [] }, defaults)).toThrow(BadRequestError)
  })
})

describe('isAnthropicRequest', () => {
  const at = (path: string, headers: Record<string, string> = {}) =>
    isAnthropicRequest(new Request(`http://gateway.test${path}`, { headers }), path)

  test('/v1/messages siempre; chat completions sólo con anthropic-version', () => {
    expect(at('/v1/messages')).toBe(true)
    expect(at('/v1/chat/completions', { 'anthropic-version': '2023-06-01' })).toBe(true)
    expect(at('/v1/chat/completions')).toBe(false)
    expect(at('/v1/models', { 'anthropic-version': '2023-06-01' })).toBe(false)
  })
})
