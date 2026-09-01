import { describe, expect, it } from 'vitest'
import { EngineEventSchema, EventScopeSchema, createEvent, deriveEvent } from '../events.js'

describe('EngineEventSchema', () => {
  it('acepta un evento mínimo y aplica el default de depth', () => {
    const parsed = EngineEventSchema.parse({
      id: 'e1',
      type: 'issue.created',
      occurredAt: '2026-01-01T00:00:00.000Z',
      source: 'engine',
      scope: {},
      payload: {},
    })
    expect(parsed.depth).toBe(0)
    expect(parsed.causationId).toBeUndefined()
  })

  it('rechaza un evento sin tipo o sin origen', () => {
    const base = {
      id: 'e1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      scope: {},
      payload: {},
    }
    expect(EngineEventSchema.safeParse({ ...base, source: 'engine' }).success).toBe(false)
    expect(EngineEventSchema.safeParse({ ...base, type: 'x' }).success).toBe(false)
  })

  it('el scope es enteramente opcional — un evento puede llegar sin rutear', () => {
    // Es el caso de un mensaje suelto de Slack. El matcher es fail-closed, así
    // que sólo lo verán las reglas sin scope, y asignárselo es un paso
    // explícito del pipeline.
    expect(EventScopeSchema.parse({})).toEqual({})
  })
})

describe('createEvent', () => {
  it('completa id, occurredAt y depth', () => {
    const e = createEvent({ type: 'x', source: 'engine', scope: {}, payload: {} })
    expect(e.id).toContain('x:')
    expect(e.depth).toBe(0)
    expect(Number.isNaN(Date.parse(e.occurredAt))).toBe(false)
  })

  it('dos eventos del mismo tipo NO comparten id', () => {
    // Dos scans del mismo issue son dos hechos distintos y los dos tienen que
    // despachar; deduplicarlos por id dejaría al issue sin reintento. La
    // identidad semántica la traen los productores que la tienen (el
    // X-GitHub-Delivery de un webhook), pasando su propio id.
    const a = createEvent({ type: 'x', source: 'engine', scope: {}, payload: {} })
    const b = createEvent({ type: 'x', source: 'engine', scope: {}, payload: {} })
    expect(a.id).not.toBe(b.id)
  })

  it('respeta el id que trae el productor', () => {
    const e = createEvent({
      id: 'delivery-123',
      type: 'x',
      source: 'github',
      scope: {},
      payload: {},
    })
    expect(e.id).toBe('delivery-123')
  })
})

describe('deriveEvent', () => {
  it('hereda la cadena de causación e incrementa la profundidad', () => {
    const cause = createEvent({ type: 'a', source: 'engine', scope: {}, payload: {} })
    const derived = deriveEvent(cause, { type: 'b', source: 'engine', scope: {}, payload: {} })
    expect(derived.causationId).toBe(cause.id)
    expect(derived.depth).toBe(1)
  })

  it('la profundidad se acumula en la cadena', () => {
    // Es lo que hace que el tope del bus pueda cortar un ciclo: si cada salto
    // reiniciara depth en 0, el freno no frenaría nada.
    let e = createEvent({ type: 'a', source: 'engine', scope: {}, payload: {} })
    for (let i = 0; i < 3; i++) {
      e = deriveEvent(e, { type: 'b', source: 'engine', scope: {}, payload: {} })
    }
    expect(e.depth).toBe(3)
  })
})
