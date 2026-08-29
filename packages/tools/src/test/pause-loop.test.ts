import { describe, expect, it } from 'bun:test'
import type { ToolContext } from '../contract.js'
import { executeLoop, registerTool } from '../engine.js'

const CTX: ToolContext = { repoPaths: {} }

registerTool({
  name: '__test_pause__',
  description: 'pide pausa',
  input_schema: { type: 'object', properties: {} },
  async execute(_input, ctx) {
    ctx.control?.requestPause('me lo pidieron')
    return 'pausado'
  },
})

function toolUse(id = 'tu1') {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id, name: '__test_pause__', input: {} }],
  }
}

describe('executeLoop — pausa', () => {
  it('corta al tope de la vuelta SIGUIENTE, no donde se pidió', async () => {
    // Cortar donde se pide dejaría el `tool_use` sin `tool_result`, y el
    // request de reanudación con esa historia falla.
    let calls = 0
    const result = await executeLoop(
      async () => {
        calls++
        return toolUse()
      },
      [{ role: 'user', content: 'hacelo' }],
      CTX,
    )

    expect(result.stopReason).toBe('paused')
    // Una sola llamada a la API: la segunda vuelta cortó antes del fetch.
    expect(calls).toBe(1)
  })

  it('el checkpoint incluye el tool_result de la llamada que pidió el corte', async () => {
    const result = await executeLoop(
      async () => toolUse(),
      [{ role: 'user', content: 'hacelo' }],
      CTX,
    )

    const msgs = result.checkpoint?.messages as Array<{ role: string; content: unknown }>
    expect(msgs).toBeDefined()
    // user (prompt) → assistant (tool_use) → user (tool_result)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(JSON.stringify(msgs.at(-1))).toContain('tool_result')
  })

  it('conserva el motivo que dio la tool', async () => {
    const result = await executeLoop(async () => toolUse(), [{ role: 'user', content: 'x' }], CTX)
    expect(result.checkpoint?.reason).toBe('me lo pidieron')
  })

  it('un run que termina normal no trae checkpoint', async () => {
    const result = await executeLoop(
      async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'listo' }] }),
      [{ role: 'user', content: 'x' }],
      CTX,
    )
    expect(result.checkpoint).toBeUndefined()
    expect(result.stopReason).toBe('end_turn')
  })

  it('el checkpoint es reanudable: entrar con esos mensajes continúa la conversación', async () => {
    const first = await executeLoop(
      async () => toolUse(),
      [{ role: 'user', content: 'hacelo' }],
      CTX,
    )

    let resumedWith: unknown[] = []
    await executeLoop(
      async (msgs) => {
        resumedWith = [...msgs]
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'seguí' }] }
      },
      first.checkpoint!.messages as Array<{ role: 'user' | 'assistant'; content: unknown }>,
      CTX,
    )

    // La reanudación arranca con la historia completa, no con el prompt.
    expect(resumedWith).toHaveLength(3)
  })
})
