import { describe, expect, test } from 'bun:test'
import { parseTranscriptUsage } from './transcript-usage.js'

function assistant(id: string, model: string, usage: Record<string, number>): string {
  return JSON.stringify({ type: 'assistant', message: { id, model, usage } })
}

describe('parseTranscriptUsage', () => {
  test('suma el usage de los mensajes del assistant', () => {
    const text = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hola' } }),
      assistant('m1', 'claude-sonnet-5', {
        input_tokens: 10,
        output_tokens: 100,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 500,
      }),
      assistant('m2', 'claude-sonnet-5', {
        input_tokens: 5,
        output_tokens: 50,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 0,
      }),
    ].join('\n')

    expect(parseTranscriptUsage(text)).toEqual({
      usage: {
        inputTokens: 15,
        outputTokens: 150,
        cacheReadTokens: 3000,
        cacheCreationTokens: 500,
      },
      model: 'claude-sonnet-5',
    })
  })

  test('deduplica las líneas que repiten el mismo mensaje (una por bloque)', () => {
    const usage = { input_tokens: 2, output_tokens: 400, cache_read_input_tokens: 0 }
    const text = [
      assistant('m1', 'claude-opus-5', usage),
      assistant('m1', 'claude-opus-5', usage),
    ].join('\n')
    expect(parseTranscriptUsage(text)?.usage.outputTokens).toBe(400)
  })

  test('elige el modelo que domina la sesión', () => {
    const text = [
      assistant('a', 'claude-haiku-4-5', { output_tokens: 1 }),
      assistant('b', 'claude-opus-5', { output_tokens: 1 }),
      assistant('c', 'claude-opus-5', { output_tokens: 1 }),
    ].join('\n')
    expect(parseTranscriptUsage(text)?.model).toBe('claude-opus-5')
  })

  test('ignora líneas rotas y devuelve undefined sin mensajes del assistant', () => {
    expect(parseTranscriptUsage('{no json\n\n')).toBeUndefined()
    expect(parseTranscriptUsage('')).toBeUndefined()
    const text = ['{ oops', assistant('m1', 'claude-sonnet-5', { output_tokens: 7 })].join('\n')
    expect(parseTranscriptUsage(text)?.usage.outputTokens).toBe(7)
  })
})
