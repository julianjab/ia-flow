import { beforeEach, describe, expect, it } from 'bun:test'
import type { ToolContext } from '../contract.js'
import { getTool } from '../engine.js'
import { type PausePort, setPausePort } from '../wait/pause-until.js'

// Lo que la tool le pidió al store. Es donde se ve si la condición de
// despertar viaja o si quedó hardcodeada.
let seen: Parameters<PausePort['pause']>[0] | undefined

const CTX: ToolContext = {
  repoPaths: {},
  taskId: 't1',
  agentId: 'implementer',
  projectId: 'p1',
  control: { requestPause: () => {} },
} as unknown as ToolContext

beforeEach(() => {
  seen = undefined
  setPausePort({
    pause: async (input) => {
      seen = input
      return { id: 'w1' }
    },
  })
})

async function pause(input: Record<string, unknown>): Promise<string> {
  const tool = getTool('pause_until')
  if (!tool) throw new Error('pause_until no está registrada')
  return tool.execute(input, CTX)
}

describe('pause_until — la condición de despertar es un parámetro', () => {
  it('sin `on`, el store decide el default (no lo impone la tool)', async () => {
    // El default vive en el composition root, no acá: la tool describe la
    // intención y el store la completa.
    await pause({ reason: 'me lo pidieron' })

    expect(seen?.on).toBeUndefined()
  })

  it('con `on` y `when`, los propaga tal cual', async () => {
    // El caso que motivó el cambio: "pará hasta que se mergee el PR 5". Quien
    // ordena la pausa SÍ sabe qué la destraba, y hardcodear `task.message`
    // tiraba esa información.
    await pause({
      reason: 'hasta que salga el PR',
      on: ['pr.merged'],
      when: [{ field: 'pr.number', op: '=', value: '5' }],
    })

    expect(seen?.on).toEqual(['pr.merged'])
    expect(seen?.when).toEqual([{ field: 'pr.number', op: '=', value: '5' }])
  })

  it('un `on` vacío cae al default en vez de rechazar', async () => {
    // Sin al menos un tipo nada podría despertar la pausa. Fallar dejaría al
    // agente que ya pidió parar sin forma de cerrar su turno.
    await pause({ on: [] })

    expect(seen?.on).toBeUndefined()
  })

  it('un `when` sin `on` propio se descarta', async () => {
    // No tendría contra qué evaluarse: el default es un mensaje de la tarea,
    // cuyos campos el agente no está filtrando.
    await pause({ when: [{ field: 'pr.number', op: '=', value: '5' }] })

    expect(seen?.when).toBeUndefined()
  })

  it('el mensaje de vuelta nombra lo que va a despertar al agente', async () => {
    const out = await pause({ on: ['ci.finished'] })

    expect(out).toContain('ci.finished')
  })
})
