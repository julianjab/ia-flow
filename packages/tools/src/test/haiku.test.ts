import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { askHaiku } from '../haiku.js'

// El camino de salida estructurada: una tool sintética con `tool_choice`
// forzado. Lo que se prueba es el contrato con la API, que es lo único que
// este helper aporta — la credencial y el logging ya estaban probados por uso.

const realFetch = globalThis.fetch
let lastBody: Record<string, unknown> = {}

function respond(content: unknown[]) {
  globalThis.fetch = mock(async (_url: unknown, init: unknown) => {
    lastBody = JSON.parse((init as { body: string }).body)
    return new Response(JSON.stringify({ content, usage: {} }), { status: 200 })
  }) as unknown as typeof fetch
}

const TOOL = { name: 'fill', description: 'llenalo', inputSchema: { type: 'object' } }

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
})
afterEach(() => {
  globalThis.fetch = realFetch
  process.env.ANTHROPIC_API_KEY = undefined
})

describe('askHaiku con tool', () => {
  test('manda la tool y fuerza su uso', async () => {
    respond([{ type: 'tool_use', name: 'fill', input: { a: 1 } }])
    const res = await askHaiku({ system: 's', user: 'u', maxTokens: 100, scope: {}, tool: TOOL })
    expect(res.toolInput).toEqual({ a: 1 })
    expect(lastBody.tool_choice).toEqual({ type: 'tool', name: 'fill' })
    expect((lastBody.tools as Array<{ input_schema: unknown }>)[0]?.input_schema).toEqual({
      type: 'object',
    })
  })

  test('sin la tool en la respuesta devuelve null en vez de tirar', async () => {
    // Pasa de verdad: un corte por `max_tokens` deja el `tool_use` a medias y
    // la API lo omite. Quien llama distingue eso de "no hay red"; tirar acá
    // obligaría a cada caller a envolver la llamada para poder hacerlo.
    respond([{ type: 'text', text: 'perdón, no puedo' }])
    const res = await askHaiku({ system: 's', user: 'u', maxTokens: 100, scope: {}, tool: TOOL })
    expect(res.toolInput).toBeNull()
    expect(res.text).toBe('perdón, no puedo')
  })

  test('sin tool no manda tools ni tool_choice', async () => {
    respond([{ type: 'text', text: 'hola' }])
    const res = await askHaiku({ system: 's', user: 'u', maxTokens: 100, scope: {} })
    expect(res.text).toBe('hola')
    expect(res.toolInput).toBeNull()
    expect(lastBody.tools).toBeUndefined()
    expect(lastBody.tool_choice).toBeUndefined()
  })
})
