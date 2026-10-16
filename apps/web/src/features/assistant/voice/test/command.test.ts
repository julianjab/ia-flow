import { describe, expect, it } from 'vitest'
import { withoutSendWord } from '../command'

describe('withoutSendWord', () => {
  it('saca la palabra de envío del final, con o sin tilde ni puntuación', () => {
    expect(withoutSendWord('¿qué falló hoy? enviar')).toBe('¿qué falló hoy?')
    expect(withoutSendWord('qué falló hoy, Envía.')).toBe('qué falló hoy')
    expect(withoutSendWord('revisá la 42 listo')).toBe('revisá la 42')
    expect(withoutSendWord('mandalo')).toBe('')
  })

  it('en el medio, o como parte de otra palabra, no envía', () => {
    expect(withoutSendWord('enviar un mail a soporte')).toBeNull()
    expect(withoutSendWord('está todo alisto')).toBeNull()
    expect(withoutSendWord('qué falló hoy')).toBeNull()
  })
})
