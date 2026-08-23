import { describe, expect, it } from 'bun:test'
import type { Task } from '@ia-flow/shared'
import { type AdmissionRequest, decline, withinDeclaredCap } from './admission.js'

function req(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    task: { id: 't1', title: 'x', status: 'Build' } as Task,
    running: 0,
    ...overrides,
  }
}

describe('withinDeclaredCap', () => {
  it('sin cap declarado admite, por muchos runs que haya', () => {
    expect(withinDeclaredCap(req({ running: 99 })).accept).toBe(true)
  })

  it('un cap de 0 admite — nunca significa "frenar todo"', () => {
    expect(withinDeclaredCap(req({ running: 5, cap: 0 })).accept).toBe(true)
  })

  it('admite mientras quede lugar y rechaza al alcanzar el cap', () => {
    expect(withinDeclaredCap(req({ running: 1, cap: 2 })).accept).toBe(true)
    expect(withinDeclaredCap(req({ running: 2, cap: 2 })).accept).toBe(false)
  })

  it('el rechazo dice los números — es lo que después se lee en el log', () => {
    const verdict = withinDeclaredCap(req({ running: 3, cap: 3 }))
    expect(verdict).toMatchObject({ accept: false, reason: expect.stringContaining('3/3') })
  })
})

describe('decline', () => {
  it('lleva motivo y, opcionalmente, una pista de cuándo reintentar', () => {
    expect(decline('RAM al límite', 30_000)).toEqual({
      accept: false,
      reason: 'RAM al límite',
      retryAfterMs: 30_000,
    })
  })
})
