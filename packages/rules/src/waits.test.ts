import { describe, expect, test } from 'bun:test'
import { type EngineEvent, type Wait, createEvent } from '@ia-flow/shared'
import { expiredWaits, isPause, matchWaits, matchesWait } from './waits.js'

const NOW = Date.parse('2026-01-01T12:00:00.000Z')
const IN_AN_HOUR = new Date(NOW + 3_600_000).toISOString()
const AN_HOUR_AGO = new Date(NOW - 3_600_000).toISOString()

function wait(over: Partial<Wait> = {}): Wait {
  return {
    id: 'w1',
    projectId: 'p1',
    taskId: 't1',
    agentId: 'builder',
    on: ['ci.finished'],
    expiresAt: IN_AN_HOUR,
    checkpoint: null,
    createdAt: '2026-01-01T11:00:00.000Z',
    ...over,
  }
}

function ev(over: Partial<EngineEvent> = {}): EngineEvent {
  return createEvent({
    type: 'ci.finished',
    source: 'github',
    scope: { projectId: 'p1', issueId: 't1' },
    payload: { conclusion: 'success' },
    ...over,
  })
}

describe('matchesWait', () => {
  test('despierta con el tipo, el proyecto y la task correctos', () => {
    expect(matchesWait(wait(), ev(), NOW)).toBe(true)
  })

  test('un tipo que no está en on[] no despierta', () => {
    expect(matchesWait(wait(), ev({ type: 'pr.opened' }), NOW)).toBe(false)
  })

  test('un evento de otro proyecto no despierta', () => {
    expect(matchesWait(wait(), ev({ scope: { projectId: 'p2', issueId: 't1' } }), NOW)).toBe(false)
  })

  test('un evento de OTRA task no despierta — es el filtro que hace seguro esperar', () => {
    // Con varias tasks en vuelo, un ci.finished de otro PR no puede reanudar
    // el run equivocado.
    expect(matchesWait(wait(), ev({ scope: { projectId: 'p1', issueId: 't2' } }), NOW)).toBe(false)
  })

  test('un evento sin issueId igual puede despertarla', () => {
    // Fuga deliberada: un ci.finished que GitHub no pudo atar a un PR sigue
    // sirviendo si las condiciones dan (esperar por branch).
    expect(matchesWait(wait(), ev({ scope: { projectId: 'p1' } }), NOW)).toBe(true)
  })

  test('las condiciones evalúan contra el payload', () => {
    const w = wait({ when: [{ field: 'conclusion', op: '=', value: 'success' }] })
    expect(matchesWait(w, ev({ payload: { conclusion: 'success' } }), NOW)).toBe(true)
    expect(matchesWait(w, ev({ payload: { conclusion: 'failure' } }), NOW)).toBe(false)
  })

  test('una espera vencida ya no despierta', () => {
    // El barrido puede no haber pasado todavía; el matcher no puede confiar
    // en que lo que está en la tabla sigue vivo.
    expect(matchesWait(wait({ expiresAt: AN_HOUR_AGO }), ev(), NOW)).toBe(false)
  })
})

describe('matchWaits', () => {
  test('devuelve las que matchean, la más vieja primero', () => {
    const older = wait({ id: 'older', createdAt: '2026-01-01T10:00:00.000Z' })
    const newer = wait({ id: 'newer', createdAt: '2026-01-01T11:30:00.000Z' })
    expect(matchWaits([newer, older], ev(), NOW).map((w) => w.id)).toEqual(['older', 'newer'])
  })

  test('sin ninguna que matchee devuelve vacío', () => {
    expect(matchWaits([wait({ on: ['pr.opened'] })], ev(), NOW)).toEqual([])
  })
})

describe('expiredWaits', () => {
  test('sólo las que ya vencieron', () => {
    const vencida = wait({ id: 'vencida', expiresAt: AN_HOUR_AGO })
    expect(expiredWaits([vencida, wait()], NOW).map((w) => w.id)).toEqual(['vencida'])
  })
})

describe('isPause', () => {
  test('una espera con checkpoint es una pausa', () => {
    // La distinción es de datos, no de tipo: preguntarla acá evita que cada
    // consumidor invente su propio criterio.
    expect(isPause(wait())).toBe(false)
    expect(isPause(wait({ checkpoint: { messages: [] } }))).toBe(true)
  })
})
