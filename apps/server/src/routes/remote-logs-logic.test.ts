import { describe, expect, it } from 'bun:test'
import { attribute, resolveCaller, secretEquals } from './remote-logs-logic.js'

const HOLDERS = [
  { id: 'julianbuitrago-mac', token: 'gw-token-aaaa' },
  { id: 'build-box', token: 'gw-token-bbbb' },
]

describe('resolveCaller', () => {
  it('el secreto global identifica al upstream', () => {
    expect(resolveCaller('global-secret', 'global-secret', HOLDERS)).toEqual({ source: 'upstream' })
  })

  it('el token de una registración identifica a ESE gateway', () => {
    expect(resolveCaller('gw-token-bbbb', 'global-secret', HOLDERS)).toEqual({
      source: 'gateway',
      id: 'build-box',
    })
  })

  // Es el caso del gateway contra un daemon que nunca configuró `upstream`.
  it('sirve sin secreto global', () => {
    expect(resolveCaller('gw-token-aaaa', undefined, HOLDERS)).toEqual({
      source: 'gateway',
      id: 'julianbuitrago-mac',
    })
  })

  it('rechaza un token que no es de nadie', () => {
    expect(resolveCaller('otro', 'global-secret', HOLDERS)).toBeNull()
  })

  it('sin token no hay caller', () => {
    expect(resolveCaller(undefined, 'global-secret', HOLDERS)).toBeNull()
  })

  // Fail-closed: sin ninguna credencial configurada no se acepta nada.
  it('sin secreto global y sin registraciones rechaza todo', () => {
    expect(resolveCaller('lo-que-sea', undefined, [])).toBeNull()
  })

  // Una fila sin token no puede volverse un comodín que acepte `undefined`.
  it('ignora registraciones sin token', () => {
    expect(resolveCaller('', undefined, [{ id: 'sin-token' }])).toBeNull()
  })
})

describe('attribute', () => {
  it('estampa el id del gateway', () => {
    expect(attribute({ runId: 'r-1' }, { source: 'gateway', id: 'build-box' })).toEqual({
      runId: 'r-1',
      gateway: 'build-box',
    })
  })

  // Lo que hace útil la atribución: el emisor NO elige con qué nombre aparece.
  it('pisa el gateway que venga en el payload', () => {
    expect(
      attribute({ gateway: 'me-hago-pasar-por-otro' }, { source: 'gateway', id: 'build-box' }),
    ).toEqual({ gateway: 'build-box' })
  })

  it('sirve con extras ausente', () => {
    expect(attribute(undefined, { source: 'gateway', id: 'build-box' })).toEqual({
      gateway: 'build-box',
    })
  })

  it('no toca lo que manda el upstream — no es de un gateway', () => {
    expect(attribute({ runId: 'r-1' }, { source: 'upstream' })).toEqual({ runId: 'r-1' })
  })
})

describe('secretEquals', () => {
  it('compara por valor', () => {
    expect(secretEquals('abc', 'abc')).toBe(true)
    expect(secretEquals('abc', 'abd')).toBe(false)
  })

  it('largos distintos no tiran', () => {
    expect(secretEquals('a', 'abcdef')).toBe(false)
  })

  it('undefined es false', () => {
    expect(secretEquals(undefined, 'abc')).toBe(false)
  })
})
