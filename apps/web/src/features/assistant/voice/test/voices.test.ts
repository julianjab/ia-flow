import { describe, expect, it } from 'vitest'
import { spanishVoices } from '../voices'

const voice = (name: string, lang: string) => ({ id: name, name, lang, local: true })

describe('spanishVoices', () => {
  it('sólo las de español, la de mejor calidad primero y, a igual calidad, la del idioma del navegador', () => {
    const list = spanishVoices(
      [
        voice('Samantha', 'en-US'),
        voice('Eddy (español (España))', 'es-ES'),
        voice('Jorge', 'es-ES'),
        voice('Paulina', 'es-MX'),
        voice('Mónica (Premium)', 'es-ES'),
        voice('Google español de Estados Unidos', 'es-US'),
        voice('Paulina (Mejorada)', 'es-MX'),
      ],
      'es-MX',
    )
    expect(list.map((v) => v.name)).toEqual([
      'Mónica (Premium)',
      'Paulina (Mejorada)',
      'Google español de Estados Unidos',
      'Paulina',
      'Jorge',
      // Las de juguete, al final.
      'Eddy (español (España))',
    ])
  })
})
