import { describe, expect, it } from 'vitest'
import { speakable, spokenParts } from '../speakable'

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

describe('spokenParts', () => {
  it('parte en frases (una lectura larga de una vez se corta sola en Chrome)', () => {
    expect(spokenParts('Falló el **build**. ¿Lo reintento? Va 3.5 veces')).toEqual([
      'Falló el build.',
      '¿Lo reintento?',
      'Va 3.5 veces',
    ])
  })
})
