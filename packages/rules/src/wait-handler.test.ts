import { describe, expect, test } from 'bun:test'
import { type EngineEvent, type Wait, createEvent } from '@ia-flow/shared'
import { WaitHandler } from './wait-handler.js'

function wait(over: Partial<Wait> = {}): Wait {
  return {
    id: 'w1',
    projectId: 'p1',
    taskId: 't1',
    agentId: 'builder',
    on: ['ci.finished'],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    checkpoint: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
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

describe('WaitHandler', () => {
  test('un evento sin proyecto no se mira siquiera', () => {
    // Una espera siempre tiene proyecto; consultarlas para un evento global
    // sería una query por evento sin nada que encontrar.
    const h = new WaitHandler({
      loadWaits: async () => [wait()],
      consume: async () => true,
      resume: async () => 'dispatched',
    })
    expect(h.handles(ev({ scope: {} }))).toBe(false)
    expect(h.handles(ev())).toBe(true)
  })

  test('consume la espera ANTES de reanudar', async () => {
    // Si el reanudado tarda, un segundo delivery del mismo evento
    // encontraría la espera viva y arrancaría un run duplicado.
    const order: string[] = []
    const h = new WaitHandler({
      loadWaits: async () => [wait()],
      consume: async () => {
        order.push('consume')
        return true
      },
      resume: async () => {
        order.push('resume')
        return 'dispatched'
      },
    })

    await h.handle(ev())
    expect(order).toEqual(['consume', 'resume'])
  })

  test('una espera que ya no estaba NO reanuda — el borrado es la idempotencia', async () => {
    // GitHub reintenta deliveries; sin esto el run despertaría dos veces.
    let resumed = 0
    const h = new WaitHandler({
      loadWaits: async () => [wait()],
      consume: async () => false,
      resume: async () => {
        resumed++
        return 'dispatched'
      },
    })

    expect(await h.handle(ev())).toBe('skipped')
    expect(resumed).toBe(0)
  })

  test('sin esperas que matcheen es skipped', async () => {
    const h = new WaitHandler({
      loadWaits: async () => [wait({ on: ['pr.opened'] })],
      consume: async () => true,
      resume: async () => 'dispatched',
    })
    expect(await h.handle(ev())).toBe('skipped')
  })

  test('un reanudado que tira no voltea al resto y se reporta', async () => {
    const errors: string[] = []
    const h = new WaitHandler({
      loadWaits: async () => [
        wait({ id: 'boom' }),
        wait({ id: 'ok', createdAt: new Date().toISOString() }),
      ],
      consume: async () => true,
      resume: async (w) => {
        if (w.id === 'boom') throw new Error('nope')
        return 'dispatched'
      },
      onError: (_e, { waitId }) => errors.push(waitId),
    })

    expect(await h.handle(ev())).toBe('dispatched')
    expect(errors).toEqual(['boom'])
  })

  test('reenvía la espera y el evento causante al reanudado', async () => {
    const seen: Array<{ waitId: string; type: string }> = []
    const h = new WaitHandler({
      loadWaits: async () => [wait()],
      consume: async () => true,
      resume: async (w, e) => {
        seen.push({ waitId: w.id, type: e.type })
        return 'dispatched'
      },
    })

    await h.handle(ev())
    expect(seen).toEqual([{ waitId: 'w1', type: 'ci.finished' }])
  })
})
