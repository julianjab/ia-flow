import { describe, expect, it } from 'bun:test'
import type { ToolContext } from '../contract.js'
import { executeLoop } from '../engine.js'

const CTX: ToolContext = { repoPaths: {} }

function done(text = 'listo') {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
}

describe('executeLoop — checkpoint espaciado', () => {
  it('cuando toca guardar, guarda exactamente la conversación que se mandó en ESA vuelta', async () => {
    // #142: el checkpoint ya no se guarda en TODAS las vueltas — se espacia
    // (ver CHECKPOINT_EVERY_ITERS/CHECKPOINT_MIN_GROWTH_BYTES en engine.ts).
    // Igual debe seguir siendo cierto que, cuando SÍ guarda, lo que persiste
    // coincide con el request real de alguna vuelta — nunca una foto inventada.
    const requestLengths: number[] = []
    const savedLengths: number[] = []
    let turn = 0
    const TOTAL_TOOL_TURNS = 20

    await executeLoop(
      async (messages) => {
        turn++
        requestLengths.push(messages.length)
        if (turn < TOTAL_TOOL_TURNS) {
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: `tu${turn}`, name: 'no_existe', input: {} }],
          }
        }
        return done()
      },
      [{ role: 'user', content: 'hacelo' }],
      CTX,
      {
        saveCheckpoint: async (state) => {
          savedLengths.push(state.messages.length)
        },
      },
    )

    expect(savedLengths.length).toBeGreaterThan(0)
    // Menos escrituras que vueltas — es el punto de espaciar.
    expect(savedLengths.length).toBeLessThan(requestLengths.length)
    for (const len of savedLengths) {
      expect(requestLengths).toContain(len)
    }
  })

  it('guarda una copia, no la referencia que el loop sigue mutando', async () => {
    // Sin la copia, todos los checkpoints guardados terminarían apuntando al
    // mismo array final (el loop lo sigue creciendo después de cada guardado)
    // y sus largos observados al final serían todos iguales entre sí.
    const saved: unknown[][] = []
    let turn = 0
    const TOTAL_TOOL_TURNS = 20

    await executeLoop(
      async () => {
        turn++
        if (turn < TOTAL_TOOL_TURNS) {
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: `tu${turn}`, name: 'no_existe', input: {} }],
          }
        }
        return done()
      },
      [{ role: 'user', content: 'hacelo' }],
      CTX,
      { saveCheckpoint: async (state) => void saved.push(state.messages) },
    )

    expect(saved.length).toBeGreaterThan(1)
    for (let i = 1; i < saved.length; i++) {
      expect(saved[i]!.length).toBeGreaterThan(saved[i - 1]!.length)
    }
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
