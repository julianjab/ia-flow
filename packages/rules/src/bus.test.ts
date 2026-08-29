import { describe, expect, test } from 'bun:test'
import { type EngineEvent, MAX_EVENT_DEPTH, createEvent } from '@ia-flow/shared'
import { type EventHandler, type EventOutcome, InMemoryEventBus, aggregateOutcomes } from './bus.js'

function ev(over: Partial<EngineEvent> = {}): EngineEvent {
  return createEvent({
    type: 'issue.scanned',
    source: 'engine',
    scope: { projectId: 'p1' },
    payload: {},
    ...over,
  })
}

function handler(
  id: string,
  outcome: EventOutcome | (() => Promise<EventOutcome>),
  handles: (e: EngineEvent) => boolean = () => true,
): EventHandler {
  return {
    id,
    handles,
    handle: typeof outcome === 'function' ? outcome : async () => outcome,
  }
}

describe('aggregateOutcomes', () => {
  test('deferred gana sobre todo', () => {
    // Perderlo detrás del skipped de otro handler dejaría el item sin
    // reintento hasta el próximo scan de la fuente.
    expect(aggregateOutcomes(['skipped', 'deferred', 'dispatched'])).toBe('deferred')
  })

  test('dispatched gana sobre skipped', () => {
    expect(aggregateOutcomes(['skipped', 'dispatched'])).toBe('dispatched')
  })

  test('sin nada que reportar es skipped', () => {
    expect(aggregateOutcomes([])).toBe('skipped')
    expect(aggregateOutcomes(['skipped', 'skipped'])).toBe('skipped')
  })
})

describe('InMemoryEventBus', () => {
  test('un evento sin suscriptores es skipped, no un error', () => {
    const bus = new InMemoryEventBus()
    expect(bus.publish(ev())).resolves.toBe('skipped')
  })

  test('entrega sólo a los handlers cuyo handles() acepta', async () => {
    const seen: string[] = []
    const bus = new InMemoryEventBus()
    bus.register(
      handler(
        'a',
        async () => {
          seen.push('a')
          return 'dispatched'
        },
        (e) => e.scope.projectId === 'p1',
      ),
    )
    bus.register(
      handler(
        'b',
        async () => {
          seen.push('b')
          return 'dispatched'
        },
        (e) => e.scope.projectId === 'p2',
      ),
    )

    await bus.publish(ev({ scope: { projectId: 'p1' } }))
    expect(seen).toEqual(['a'])
  })

  test('agrega los resultados de varios handlers', async () => {
    const bus = new InMemoryEventBus()
    bus.register(handler('a', 'skipped'))
    bus.register(handler('b', 'deferred'))
    expect(await bus.publish(ev())).toBe('deferred')
  })

  test('un handler que tira no voltea al resto y cuenta como skipped', async () => {
    // Mismo criterio que tenía el catch de startAll en daemon.ts: un throw no
    // es falta de capacidad, así que el item se suelta en vez de reintentarse
    // en loop contra un error que no se arregla solo.
    const errors: string[] = []
    const bus = new InMemoryEventBus({
      onError: (_err, { handlerId }) => errors.push(handlerId ?? '?'),
    })
    bus.register(
      handler('boom', async () => {
        throw new Error('nope')
      }),
    )
    bus.register(handler('ok', 'dispatched'))

    expect(await bus.publish(ev())).toBe('dispatched')
    expect(errors).toEqual(['boom'])
  })

  test('un handles() roto descarta a su handler, no al evento', async () => {
    const errors: string[] = []
    const bus = new InMemoryEventBus({
      onError: (_err, { handlerId }) => errors.push(handlerId ?? '?'),
    })
    bus.register(
      handler('broken', 'dispatched', () => {
        throw new Error('bad predicate')
      }),
    )
    bus.register(handler('ok', 'dispatched'))

    expect(await bus.publish(ev())).toBe('dispatched')
    expect(errors).toEqual(['broken'])
  })

  test('unregister corta la entrega', async () => {
    const bus = new InMemoryEventBus()
    const off = bus.register(handler('a', 'dispatched'))
    expect(await bus.publish(ev())).toBe('dispatched')
    off()
    expect(await bus.publish(ev())).toBe('skipped')
  })

  test('un evento con un id ya procesado no se entrega', async () => {
    // Es lo que hace que la identidad sirva para algo: GitHub y Slack
    // reintentan deliveries, y un tick de cron que se solapa comparte minuto.
    const seen = new Set<string>()
    const duplicates: string[] = []
    const bus = new InMemoryEventBus({
      markProcessed: async (e) => {
        if (seen.has(e.id)) return true
        seen.add(e.id)
        return false
      },
      onDuplicate: (e) => duplicates.push(e.id),
    })
    let handled = 0
    bus.register(
      handler('a', async () => {
        handled++
        return 'dispatched'
      }),
    )

    const event = ev()
    expect(await bus.publish(event)).toBe('dispatched')
    expect(await bus.publish(event)).toBe('skipped')
    expect(handled).toBe(1)
    expect(duplicates).toEqual([event.id])
  })

  test('sin dedupe cableado se entrega siempre — comportamiento previo', async () => {
    const bus = new InMemoryEventBus()
    let handled = 0
    bus.register(
      handler('a', async () => {
        handled++
        return 'dispatched'
      }),
    )
    const event = ev()
    await bus.publish(event)
    await bus.publish(event)
    expect(handled).toBe(2)
  })

  test('descarta el evento que excede el tope de profundidad', async () => {
    // El freno de los ciclos: A emite X, B reacciona y emite Y, C reacciona y
    // emite X. Sin esto no hay nada que lo corte.
    const exceeded: EngineEvent[] = []
    const bus = new InMemoryEventBus({ onDepthExceeded: (e) => exceeded.push(e) })
    let handled = 0
    bus.register(
      handler('a', async () => {
        handled++
        return 'dispatched'
      }),
    )

    expect(await bus.publish(ev({ depth: MAX_EVENT_DEPTH }))).toBe('dispatched')
    expect(handled).toBe(1)

    expect(await bus.publish(ev({ depth: MAX_EVENT_DEPTH + 1 }))).toBe('skipped')
    expect(handled).toBe(1)
    expect(exceeded).toHaveLength(1)
  })
})
