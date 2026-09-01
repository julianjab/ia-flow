import { describe, expect, it } from 'bun:test'
import type { InjectedMessage, ToolContext } from '../contract.js'
import { executeLoop } from '../engine.js'

const CTX: ToolContext = { repoPaths: {} }

function endTurn(text = 'ok') {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
}

describe('executeLoop — mensajes inyectados', () => {
  it('agrega los pendientes como un mensaje de usuario antes del turno', async () => {
    // El drenaje va ANTES del fetch: es el único punto del turno donde
    // agregar contenido no rompe nada.
    const seen: unknown[][] = []
    const messages: InjectedMessage[] = [{ id: 'm1', body: 'mirá también el login' }]

    await executeLoop(
      async (msgs) => {
        seen.push([...msgs])
        return endTurn()
      },
      [{ role: 'user', content: 'arreglá el bug' }],
      CTX,
      { drainMessages: async () => messages.splice(0) },
    )

    expect(seen[0]).toHaveLength(2)
    expect((seen[0] as Array<{ content: string }>)[1].content).toBe('mirá también el login')
  })

  it('prefija el autor cuando lo hay', async () => {
    let sent: Array<{ content: unknown }> = []
    await executeLoop(
      async (msgs) => {
        sent = [...msgs] as Array<{ content: unknown }>
        return endTurn()
      },
      [{ role: 'user', content: 'x' }],
      CTX,
      {
        drainMessages: async () => [{ id: 'm1', body: 'pará', author: 'julian' }],
        onMessagesDelivered: async () => {},
      },
    )
    expect(sent[1].content).toBe('[julian] pará')
  })

  it('junta varios pendientes en un solo mensaje', async () => {
    let sent: Array<{ content: unknown }> = []
    let drained = false
    await executeLoop(
      async (msgs) => {
        sent = [...msgs] as Array<{ content: unknown }>
        return endTurn()
      },
      [{ role: 'user', content: 'x' }],
      CTX,
      {
        drainMessages: async () => {
          if (drained) return []
          drained = true
          return [
            { id: 'a', body: 'uno' },
            { id: 'b', body: 'dos' },
          ]
        },
      },
    )
    expect(sent[1].content).toBe('uno\n\ndos')
  })

  it('marca entregado DESPUÉS de incorporar, no antes', async () => {
    // Un run que muere entre el drenaje y el turno tiene que poder volver a
    // leerlos, así que el orden importa.
    const order: string[] = []
    await executeLoop(
      async () => {
        order.push('fetch')
        return endTurn()
      },
      [{ role: 'user', content: 'x' }],
      CTX,
      {
        drainMessages: async () => {
          order.push('drain')
          return [{ id: 'm1', body: 'hola' }]
        },
        onMessagesDelivered: async (ids) => {
          order.push(`delivered:${ids.join(',')}`)
        },
      },
    )
    expect(order).toEqual(['drain', 'delivered:m1', 'fetch'])
  })

  it('sin nada pendiente no toca la historia', async () => {
    let sent: unknown[] = []
    let delivered = 0
    await executeLoop(
      async (msgs) => {
        sent = [...msgs]
        return endTurn()
      },
      [{ role: 'user', content: 'x' }],
      CTX,
      {
        drainMessages: async () => [],
        onMessagesDelivered: async () => {
          delivered++
        },
      },
    )
    expect(sent).toHaveLength(1)
    expect(delivered).toBe(0)
  })

  it('un fallo del store no voltea el run', async () => {
    // El agente sigue con lo que tenía y el mensaje se reintenta el turno que
    // viene: perder un run por un problema de la cola es peor que atrasarlo.
    const result = await executeLoop(
      async () => endTurn('igual terminé'),
      [{ role: 'user', content: 'x' }],
      CTX,
      {
        drainMessages: async () => {
          throw new Error('store caído')
        },
      },
    )
    expect(result.text).toBe('igual terminé')
  })

  it('sin el hook, el loop se comporta como siempre', async () => {
    let sent: unknown[] = []
    const result = await executeLoop(
      async (msgs) => {
        sent = [...msgs]
        return endTurn()
      },
      [{ role: 'user', content: 'x' }],
      CTX,
    )
    expect(sent).toHaveLength(1)
    expect(result.iters).toBe(1)
  })
})
