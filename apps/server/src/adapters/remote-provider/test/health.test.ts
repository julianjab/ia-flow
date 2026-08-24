import { describe, expect, it } from 'bun:test'
import { UNKNOWN_HEALTH, applyProbe, isAvailable } from '../health.js'

const AT = '2026-01-01T00:00:05Z'

describe('applyProbe', () => {
  it('una sonda OK deja el provider disponible y resetea los fallos', () => {
    const prev = { status: 'down' as const, error: 'timeout', consecutiveFailures: 4 }
    const next = applyProbe(prev, { ok: true, latencyMs: 12 }, AT)

    expect(next).toEqual({
      status: 'ok',
      checkedAt: AT,
      latencyMs: 12,
      consecutiveFailures: 0,
    })
    expect(isAvailable(next)).toBe(true)
  })

  it('un solo fallo alcanza para marcarlo caído', () => {
    const next = applyProbe(UNKNOWN_HEALTH, { ok: false, error: 'ECONNREFUSED' }, AT)

    expect(next.status).toBe('down')
    expect(next.error).toBe('ECONNREFUSED')
    expect(next.consecutiveFailures).toBe(1)
    expect(isAvailable(next)).toBe(false)
  })

  it('acumula fallos seguidos para poder mostrar hace cuánto está caído', () => {
    let health = UNKNOWN_HEALTH
    for (let i = 0; i < 3; i++) health = applyProbe(health, { ok: false, error: 'nope' }, AT)

    expect(health.consecutiveFailures).toBe(3)
  })
})

describe('isAvailable', () => {
  it('`unknown` no cuenta como disponible — todavía no se sondeó', () => {
    expect(isAvailable(UNKNOWN_HEALTH)).toBe(false)
  })
})
