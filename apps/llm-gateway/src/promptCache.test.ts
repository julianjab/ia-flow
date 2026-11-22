import { describe, expect, test } from 'bun:test'
import { withPromptCache } from './promptCache.js'

const CACHE = { cache_control: { type: 'ephemeral' } }
const count = (body: unknown) => JSON.stringify(body).match(/cache_control/g)?.length ?? 0

describe('withPromptCache', () => {
  test('system string pasa a bloque marcado; tools y último mensaje también', () => {
    const out = withPromptCache({
      system: 'sé breve',
      tools: [{ name: 'a' }, { name: 'b' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hola' }] }],
    }) as Record<string, unknown>
    expect(out.system).toEqual([{ type: 'text', text: 'sé breve', ...CACHE }])
    expect(out.tools).toEqual([{ name: 'a' }, { name: 'b', ...CACHE }])
    expect(count(out.messages)).toBe(1)
  })

  test('system en array: sólo el último bloque', () => {
    const out = withPromptCache({
      system: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hola' }] }],
    })
    expect(out.system).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b', ...CACHE },
    ])
  })

  test('el contenido string del último mensaje pasa a bloque de texto', () => {
    const out = withPromptCache({ messages: [{ role: 'user', content: 'hola' }] })
    expect(out.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hola', ...CACHE }] },
    ])
  })

  test('no duplica lo que el body ya trae y no muta la entrada', () => {
    const body = {
      system: [{ type: 'text', text: 'a', ...CACHE }],
      tools: [{ name: 'a', ...CACHE }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hola' }] }],
    }
    const before = JSON.stringify(body)
    const out = withPromptCache(body)
    expect(count(out)).toBe(3)
    expect(count(out.system)).toBe(1)
    expect(count(out.tools)).toBe(1)
    expect(JSON.stringify(body)).toBe(before)
  })

  test('respeta el máximo de 4 breakpoints', () => {
    const out = withPromptCache({
      system: [{ type: 'text', text: 's' }],
      tools: [{ name: 'a' }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '1', ...CACHE },
            { type: 'text', text: '2', ...CACHE },
            { type: 'text', text: '3', ...CACHE },
          ],
        },
      ],
    })
    expect(count(out)).toBe(4)
  })

  test('sin mensajes ni system ni tools no inventa nada', () => {
    expect(withPromptCache({ model: 'x' })).toEqual({ model: 'x' })
  })
})
