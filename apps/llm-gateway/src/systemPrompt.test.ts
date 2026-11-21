import { describe, expect, test } from 'bun:test'
import { prependSystemPrompt } from './systemPrompt.js'

describe('prependSystemPrompt', () => {
  test('el prompt va primero y solo, sea el system string o bloques', () => {
    expect(prependSystemPrompt('del cliente', 'nuestro')).toEqual([
      { type: 'text', text: 'nuestro' },
      { type: 'text', text: 'del cliente' },
    ])
    expect(prependSystemPrompt([{ type: 'text', text: 'bloque' }], 'nuestro')).toEqual([
      { type: 'text', text: 'nuestro' },
      { type: 'text', text: 'bloque' },
    ])
  })

  test('sin system del cliente (ausente o vacío) sale sólo el nuestro', () => {
    expect(prependSystemPrompt(undefined, 'nuestro')).toBe('nuestro')
    expect(prependSystemPrompt('', 'nuestro')).toBe('nuestro')
  })

  test('sin prompt nuestro el system del cliente pasa intacto', () => {
    expect(prependSystemPrompt('del cliente', '')).toBe('del cliente')
    expect(prependSystemPrompt(undefined, '')).toBeUndefined()
  })
})
