import { describe, expect, it } from 'bun:test'
import { envCorsOrigins, isAllowedOrigin } from './cors.js'

describe('isAllowedOrigin', () => {
  it('localhost en cualquier puerto entra — el de la consola no es fijo', () => {
    expect(isAllowedOrigin('http://localhost:5273')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:61234')).toBe(true)
    expect(isAllowedOrigin('http://localhost')).toBe(true)
  })

  it('un origen de internet NO entra, aunque el nombre contenga localhost', () => {
    expect(isAllowedOrigin('https://evil.com')).toBe(false)
    // El chequeo es sobre el hostname parseado, no un `includes`.
    expect(isAllowedOrigin('https://localhost.evil.com')).toBe(false)
    expect(isAllowedOrigin('https://evil.com/?x=localhost')).toBe(false)
  })

  it('un Origin que no parsea (null, file://) no se refleja', () => {
    expect(isAllowedOrigin('null')).toBe(false)
    expect(isAllowedOrigin('file://')).toBe(false)
  })

  it('los extras entran tal cual — una consola servida desde otra máquina', () => {
    expect(isAllowedOrigin('https://consola.interna', ['https://consola.interna'])).toBe(true)
    expect(isAllowedOrigin('https://otra.interna', ['https://consola.interna'])).toBe(false)
  })
})

describe('envCorsOrigins', () => {
  it('separa por coma, recorta y descarta vacíos', () => {
    expect(envCorsOrigins(' https://a.com , ,https://b.com ')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
    expect(envCorsOrigins(undefined)).toEqual([])
  })
})
