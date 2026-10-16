import { describe, expect, it } from 'vitest'
import { readyPrefix, speakable } from '../speakable'

describe('readyPrefix', () => {
  it('corta en la última frase completa; lo que sigue espera', () => {
    const text = 'Falló el build. Lo reintento'
    expect(text.slice(0, readyPrefix(text, false))).toBe('Falló el build.')
  })

  it('un punto al final todavía no es frase (puede ser 3.5)', () => {
    expect(readyPrefix('Va por la versión 3.', false)).toBe(0)
  })

  it('un salto de línea cierra la frase', () => {
    expect(readyPrefix('- primero\n- seg', false)).toBe('- primero\n'.length)
  })

  it('no entra a un bloque de código abierto, y su cierre es un corte', () => {
    const open = 'Corré esto: ```bash\nmake test. y más'
    expect(open.slice(0, readyPrefix(open, false))).toBe('Corré esto:')
    const closed = 'Mirá: ```x. y``` y'
    expect(closed.slice(0, readyPrefix(closed, false))).toBe('Mirá: ```x. y```')
  })

  it('con final, todo', () => {
    expect(readyPrefix('sin punto', true)).toBe(9)
  })
})

describe('speakable', () => {
  it('saca código, tablas, viñetas y marcas; un link es «el enlace»', () => {
    const md = [
      '## Resumen',
      '- **build** falló en `apps/web`',
      '| a | b |',
      '```ts\nconst x = 1\n```',
      'Ver https://github.com/acme/api/pull/7 y snake_case.',
    ].join('\n')
    expect(speakable(md)).toBe('Resumen build falló en apps/web Ver el enlace y snake case.')
  })

  it('un bloque de código sin cerrar no se lee', () => {
    expect(speakable('Mirá: ```bash\nrm -rf')).toBe('Mirá:')
  })
})
