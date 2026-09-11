import { describe, expect, it } from 'bun:test'
import type { AssistInput, AssistResult, AssistWithAiUseCase } from '../AssistWithAiUseCase.js'
import { TaskChatUseCase } from '../TaskChatUseCase.js'

// El canal `view` es GENÉRICO: el use-case no conoce ninguna primitiva. Estas
// pruebas usan un contrato inventado a propósito —nada de `row-action`— para
// que un cambio en el contrato real de `apps/web` no las toque. Lo que se
// verifica es que el schema y el prompt se DERIVAN de lo que venga, y que
// `verify()` filtra sin entender el vocabulario.
//
// Archivo aparte de `TaskChatUseCase.test.ts` porque son dos ejes distintos:
// aquél cubre las readTools y el verify de `actions`, y su fixture apaga el
// canal `view` justamente para aislarlos.

const CONTRACT = {
  primitives: [
    {
      id: 'sticker',
      description: 'pega un sticker en las tareas que le digas',
      props: {
        type: 'object',
        properties: { taskIds: { type: 'array', items: { type: 'string' } } },
      },
      taskIdProps: ['taskIds'],
    },
  ],
}

const INPUT = {
  projectId: 'p1',
  message: '¿Qué pasa con t1?',
  history: [],
  tasks: [{ id: 't1', title: 'Arreglar el bug', status: 'In Progress', tags: [] }],
  uiContract: { primitives: [] },
}

function fakeAssist(
  fields: Record<string, unknown>,
): AssistWithAiUseCase & { calls: AssistInput[] } {
  const calls: AssistInput[] = []
  return {
    calls,
    async execute(input: AssistInput): Promise<AssistResult> {
      calls.push(input)
      return { fields }
    },
  } as unknown as AssistWithAiUseCase & { calls: AssistInput[] }
}

const OK = { reply: 'ok', scope: { type: 'project' }, actions: [] }

describe('TaskChatUseCase — contrato visual', () => {
  it('deriva el schema forzado al modelo del contrato que publicó el cliente', async () => {
    const assist = fakeAssist(OK)
    await new TaskChatUseCase(assist, []).execute({ ...INPUT, uiContract: CONTRACT })

    const schema = assist.calls[0]?.responseSchema as Record<string, any>
    const branches = schema.properties.view.properties.blocks.items.anyOf
    expect(branches).toHaveLength(1)
    expect(branches[0].properties.use.const).toBe('sticker')
    // Los `props` de la primitiva se inyectan TAL CUAL: es lo que hace que la
    // API garantice la forma sin que el server tenga que conocerla.
    expect(branches[0].properties.props).toEqual(CONTRACT.primitives[0]!.props)
  })

  it('deriva también el vocabulario del prompt — la description es lo único que el modelo lee', async () => {
    const assist = fakeAssist(OK)
    await new TaskChatUseCase(assist, []).execute({ ...INPUT, uiContract: CONTRACT })
    expect(assist.calls[0]?.description).toContain('sticker: pega un sticker')
  })

  it('sin contrato no agrega el canal `view` — ni al schema ni al prompt', async () => {
    const assist = fakeAssist(OK)
    await new TaskChatUseCase(assist, []).execute(INPUT)

    const schema = assist.calls[0]?.responseSchema as Record<string, any>
    expect(schema.properties.view).toBeUndefined()
    expect(assist.calls[0]?.description).not.toContain('view.blocks')
  })

  it('descarta un bloque cuya primitiva no está en el contrato', async () => {
    const assist = fakeAssist({
      ...OK,
      view: { blocks: [{ use: 'exfiltrar', props: { taskIds: ['t1'] } }] },
    })
    const reply = await new TaskChatUseCase(assist, []).execute({ ...INPUT, uiContract: CONTRACT })
    expect(reply.view.blocks).toEqual([])
  })

  it('filtra los taskId inventados de las props que el contrato declaró como ids', async () => {
    const assist = fakeAssist({
      ...OK,
      view: { blocks: [{ use: 'sticker', props: { taskIds: ['t1', 'no-existe'], extra: 'x' } }] },
    })
    const reply = await new TaskChatUseCase(assist, []).execute({ ...INPUT, uiContract: CONTRACT })
    // `extra` pasa intacto: el server no valida los props, sólo los ids — la
    // forma ya la garantizó la API y la revalida el renderer.
    expect(reply.view.blocks).toEqual([{ use: 'sticker', props: { taskIds: ['t1'], extra: 'x' } }])
  })

  it('descarta el bloque entero cuando NINGÚN taskId sobrevive', async () => {
    const assist = fakeAssist({
      ...OK,
      view: { blocks: [{ use: 'sticker', props: { taskIds: ['fantasma'] } }] },
    })
    const reply = await new TaskChatUseCase(assist, []).execute({ ...INPUT, uiContract: CONTRACT })
    expect(reply.view.blocks).toEqual([])
  })

  it('un `view` ausente no rompe la respuesta — queda vacío', async () => {
    const assist = fakeAssist(OK)
    const reply = await new TaskChatUseCase(assist, []).execute({ ...INPUT, uiContract: CONTRACT })
    expect(reply.view).toEqual({ blocks: [] })
  })
})
