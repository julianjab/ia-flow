import { describe, expect, it } from 'vitest'
import { formatRelative } from '../formatRelative.js'

const NOW = Date.parse('2026-01-01T12:00:00.000Z')

describe('formatRelative', () => {
  it('un ISO inválido se devuelve tal cual, en vez de "Invalid Date"', () => {
    expect(formatRelative('no es una fecha', NOW)).toBe('no es una fecha')
  })

  it('menos de 5 segundos es "ahora"', () => {
    expect(formatRelative(new Date(NOW - 3_000).toISOString(), NOW)).toBe('ahora')
  })

  it('segundos', () => {
    expect(formatRelative(new Date(NOW - 30_000).toISOString(), NOW)).toBe('hace 30 s')
  })

  it('minutos', () => {
    expect(formatRelative(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('hace 5 min')
  })

  it('horas', () => {
    expect(formatRelative(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('hace 3 h')
  })

  it('días', () => {
    expect(formatRelative(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('hace 2 d')
  })
})
