import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendTaskChatMessage = vi.fn()
vi.mock('@/features/tasks/chatApi', () => ({
  sendTaskChatMessage: (...a: unknown[]) => sendTaskChatMessage(...a),
}))

import { useTaskChatStore } from '../taskChatStore'

const TASKS = [{ id: 't1', title: 'Arreglar bug', status: 'In Progress', tags: [] }]

/** Un bloque de la primitiva real del contrato (`row-action`) — el store la
 *  resuelve por `TASK_UI_PRIMITIVES`, así que acá sí tiene que ser una que
 *  exista de verdad. */
const RUN_BLOCK = {
  use: 'row-action',
  props: { op: 'run', label: 'Correr', taskIds: ['t1', 't2'] },
}

function reply(view: unknown) {
  return { reply: 'ok', scope: { type: 'project' }, actions: [], view }
}

beforeEach(() => {
  setActivePinia(createPinia())
  sendTaskChatMessage.mockReset()
})

describe('taskChatStore — canal view', () => {
  it('reparte un bloque de fila entre TODAS las tareas que nombra', async () => {
    sendTaskChatMessage.mockResolvedValue(reply({ blocks: [RUN_BLOCK] }))
    const s = useTaskChatStore()
    await s.ask({ projectId: 'p1', message: 'agregá botón correr', tasks: TASKS })

    expect(s.rowBlocksByTask.t1).toEqual([RUN_BLOCK])
    expect(s.rowBlocksByTask.t2).toEqual([RUN_BLOCK])
    expect(s.rowBlocksByTask.t3).toBeUndefined()
  })

  it('ignora un bloque cuya primitiva este bundle no declara', async () => {
    sendTaskChatMessage.mockResolvedValue(
      reply({ blocks: [{ use: 'primitiva-del-futuro', props: { taskIds: ['t1'] } }] }),
    )
    const s = useTaskChatStore()
    await s.ask({ projectId: 'p1', message: 'x', tasks: TASKS })
    expect(s.rowBlocksByTask).toEqual({})
  })

  it('el turno siguiente REEMPLAZA la vista — así se saca un botón sin verbo para deshacer', async () => {
    const s = useTaskChatStore()
    sendTaskChatMessage.mockResolvedValue(reply({ blocks: [RUN_BLOCK] }))
    await s.ask({ projectId: 'p1', message: 'agregá botón', tasks: TASKS })
    expect(s.rowBlocksByTask.t1).toHaveLength(1)

    sendTaskChatMessage.mockResolvedValue(reply({ blocks: [] }))
    await s.ask({ projectId: 'p1', message: 'sacá el botón', tasks: TASKS })
    expect(s.rowBlocksByTask).toEqual({})
  })

  it('discard() tira la propuesta de `actions` pero NO la vista', async () => {
    sendTaskChatMessage.mockResolvedValue(reply({ blocks: [RUN_BLOCK] }))
    const s = useTaskChatStore()
    await s.ask({ projectId: 'p1', message: 'x', tasks: TASKS })

    s.discard()
    // Un bloque de vista no es un cambio que haya que confirmar: no pasa por
    // Aplicar/Descartar, así que descartar la propuesta no puede llevárselo.
    expect(s.pending).toBeNull()
    expect(s.rowBlocksByTask.t1).toEqual([RUN_BLOCK])
  })

  it('reset() sí la limpia — la vista muere con la conversación', async () => {
    sendTaskChatMessage.mockResolvedValue(reply({ blocks: [RUN_BLOCK] }))
    const s = useTaskChatStore()
    await s.ask({ projectId: 'p1', message: 'x', tasks: TASKS })

    s.reset()
    expect(s.rowBlocksByTask).toEqual({})
  })
})
