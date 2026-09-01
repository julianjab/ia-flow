import { describe, expect, it } from 'bun:test'
import type { ToolContext } from '../contract.js'
import { executeLoop } from '../engine.js'

const CTX: ToolContext = { repoPaths: {} }

function done(text = 'listo') {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
}

describe('executeLoop — checkpoint por vuelta', () => {
  it('guarda antes de cada request, con la conversación que se va a mandar', async () => {
    const saved: unknown[][] = []
    let turn = 0

    await executeLoop(
      async () => {
        turn++
        // Primera vuelta: pide una tool para que haya una segunda.
        if (turn === 1) {
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu1', name: 'no_existe', input: {} }],
          }
        }
        return done()
      },
      [{ role: 'user', content: 'hacelo' }],
      CTX,
      {
        saveCheckpoint: async (state) => {
          saved.push(state.messages)
        },
      },
    )

    // Dos requests ⇒ dos checkpoints, uno por vuelta.
    expect(saved).toHaveLength(2)
    // El primero es el prompt pelado; el segundo ya trae el ida y vuelta de la
    // tool. O sea: lo guardado es el último request ENVIADO, no una foto vieja.
    expect(saved[0]).toHaveLength(1)
    expect(saved[1]!.length).toBeGreaterThan(1)
  })

  it('guarda una copia, no la referencia que el loop sigue mutando', async () => {
    // Sin la copia, el array guardado en la vuelta 1 crecería solo hasta
    // terminar igual al de la vuelta 2 — y el checkpoint dejaría de
    // representar el request que efectivamente se mandó.
    const saved: unknown[][] = []
    let turn = 0

    await executeLoop(
      async () => {
        turn++
        if (turn === 1) {
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu1', name: 'no_existe', input: {} }],
          }
        }
        return done()
      },
      [{ role: 'user', content: 'hacelo' }],
      CTX,
      { saveCheckpoint: async (state) => void saved.push(state.messages) },
    )

    expect(saved[0]).toHaveLength(1)
  })

  it('un fallo al guardar NO voltea el run', async () => {
    // Perder el checkpoint degrada la recuperación; tirar acá tiraría el
    // trabajo que el checkpoint existe para salvar.
    const result = await executeLoop(
      async () => done('igual terminó'),
      [{ role: 'user', content: 'hacelo' }],
      CTX,
      {
        saveCheckpoint: async () => {
          throw new Error('disco lleno')
        },
      },
    )

    expect(result.stopReason).toBe('end_turn')
    expect(result.text).toContain('igual terminó')
  })

  it('sin `saveCheckpoint` el loop se comporta igual que siempre', async () => {
    const result = await executeLoop(async () => done(), [{ role: 'user', content: 'hacelo' }], CTX)

    expect(result.stopReason).toBe('end_turn')
  })
})
