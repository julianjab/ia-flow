import { describe, expect, it } from 'vitest'
import { prShortOf, refUrl, shortRef, shortRepo } from '@/features/inbox/queue/shortRef'

describe('shortRepo / shortRef', () => {
  it('quita el owner, el prefijo de organización, la versión y la capa', () => {
    expect(shortRepo('la-haus/lh-seller-v2-frontend')).toBe('seller')
    expect(shortRepo('lh-admin-backend')).toBe('admin')
  })

  it('recorta una palabra larga a sus 4 primeras letras', () => {
    expect(shortRepo('la-haus/subscriptions')).toBe('subs')
  })

  it('deja enteros los nombres cortos o de varias palabras', () => {
    expect(shortRepo('acme/api')).toBe('api')
    expect(shortRepo('julianjab/ia-flow')).toBe('ia-flow')
    expect(shortRepo('acme/web-app')).toBe('web')
  })

  it('arma el ref corto y deja tal cual uno sin #', () => {
    expect(shortRef('la-haus/lh-seller-v2-frontend#4281')).toBe('seller#4281')
    expect(shortRef('la-haus/subscriptions#1187')).toBe('subs#1187')
    expect(shortRef('board')).toBe('board')
  })

  it('arma la URL de GitHub de un ref completo; sin owner/repo#n no hay link', () => {
    expect(refUrl('la-haus/subscriptions#1187')).toBe(
      'https://github.com/la-haus/subscriptions/issues/1187',
    )
    expect(refUrl('#12')).toBeUndefined()
    expect(refUrl('board')).toBeUndefined()
  })

  it('arma el PR con el repo corto del issue; sin PR, vacío', () => {
    const pr = { number: 4302, url: 'https://github.com/x/y/pull/4302' }
    expect(prShortOf({ ref: 'la-haus/lh-seller-v2-frontend#4281', pr })).toBe('seller#4302')
    expect(prShortOf({ ref: 'la-haus/subscriptions#1187' })).toBe('')
  })
})
