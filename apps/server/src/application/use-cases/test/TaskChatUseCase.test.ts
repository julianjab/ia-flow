import { describe, expect, it } from 'bun:test'
import type { ReadOnlyTool } from '@ia-flow/tools'
import type { AssistInput, AssistResult, AssistWithAiUseCase } from '../AssistWithAiUseCase.js'
import { TaskChatUseCase } from '../TaskChatUseCase.js'

// `AssistWithAiUseCase` real es quien corre el loop de tool calls
// (`runFormFill`) — acá se testea SÓLO la parte que es de `TaskChatUseCase`:
// que arma readTools instrumentadas y las pasa, y que usa lo que esas tools
// devuelven para reportar progreso y para ampliar `knownIds`. Por eso el doble
// de `AssistWithAiUseCase` simula el loop a mano: llama a las readTools que
// recibió en el input antes de devolver `fields`, igual que haría el real.
function fakeAssistRunningReadTools(
  fields: Record<string, unknown>,
): AssistWithAiUseCase & { calls: AssistInput[] } {
  const calls: AssistInput[] = []
  return {
    calls,
    async execute(input: AssistInput): Promise<AssistResult> {
      calls.push(input)
      for (const tool of input.readTools ?? []) {
        if (tool.name === 'get_task_detail') await tool.execute({ task_id: 't2' })
        if (tool.name === 'search_tasks') await tool.execute({ query: 'bloqueado' })
      }
      return { fields }
    },
  } as unknown as AssistWithAiUseCase & { calls: AssistInput[] }
}

const detailTool: ReadOnlyTool = {
  name: 'get_task_detail',
  description: 'detail',
  input_schema: {},
  execute: async () => JSON.stringify({ id: 't2', title: 'Otra tarea' }),
}

const searchTool: ReadOnlyTool = {
  name: 'search_tasks',
  description: 'search',
  input_schema: {},
  execute: async () =>
    JSON.stringify({ tasks: [{ id: 't3' }, { id: 't4' }], total: 2, truncated: false }),
}

const VALID_INPUT = {
  projectId: 'p1',
  message: '¿Qué pasa con t2?',
  history: [],
  tasks: [{ id: 't1', title: 'Arreglar el bug', status: 'In Progress', tags: [] }],
  // Sin primitivas: el canal `view` queda apagado (ni schema ni prompt), que
  // es lo que estos casos —sobre tools y verify de `actions`— quieren aislar.
  uiContract: { primitives: [] },
}

describe('TaskChatUseCase — read tools', () => {
  it('pisa el project_id del input con el del request — el modelo no puede leer otro proyecto', async () => {
    const seenInputs: unknown[] = []
    const spyTool: ReadOnlyTool = {
      name: 'get_task_detail',
      description: 'detail',
      input_schema: {},
      execute: async (input) => {
        seenInputs.push(input)
        return JSON.stringify({ id: 't2' })
      },
    }
    const assist = {
      async execute(input: AssistInput): Promise<AssistResult> {
        // Simula un modelo que, influido por contenido inyectado en un
        // título de issue, intenta leer 'otro-proyecto' en vez de 'p1'.
        await input.readTools?.[0]?.execute({ project_id: 'otro-proyecto', task_id: 't2' })
        return { fields: { reply: 'ok', scope: { type: 'project' }, actions: [] } }
      },
    } as unknown as AssistWithAiUseCase
    const useCase = new TaskChatUseCase(assist, [spyTool])
    await useCase.execute(VALID_INPUT)
    expect(seenInputs).toEqual([{ project_id: 'p1', task_id: 't2' }])
  })

  it('pasa a AssistWithAiUseCase las readTools inyectadas (no las del registry por defecto)', async () => {
    const assist = fakeAssistRunningReadTools({
      reply: 'ok',
      scope: { type: 'project' },
      actions: [],
    })
    const useCase = new TaskChatUseCase(assist, [detailTool, searchTool])
    await useCase.execute(VALID_INPUT)
    expect(assist.calls[0]?.readTools?.map((t) => t.name)).toEqual([
      'get_task_detail',
      'search_tasks',
    ])
  })

  it('reporta un evento de progreso por cada tool call, con index e label', async () => {
    const assist = fakeAssistRunningReadTools({
      reply: 'ok',
      scope: { type: 'project' },
      actions: [],
    })
    const useCase = new TaskChatUseCase(assist, [detailTool, searchTool])
    const events: { tool: string; index: number; label: string }[] = []
    await useCase.execute(VALID_INPUT, { onProgress: (e) => events.push(e) })
    expect(events).toEqual([
      { tool: 'get_task_detail', index: 1, label: 'Leyendo la tarea t2' },
      { tool: 'search_tasks', index: 2, label: 'Buscando "bloqueado"' },
    ])
  })

  it('los taskId que devuelve una tool de lectura cuentan como conocidos — sobreviven a verify()', async () => {
    const assist = fakeAssistRunningReadTools({
      reply: 'Sobre t2 y t3',
      scope: { type: 'task', taskId: 't2' },
      actions: [
        { type: 'tag', taskId: 't2', tags: ['urgente'] },
        { type: 'reorder', taskIds: ['t3', 't4', 'no-existe'] },
      ],
    })
    const useCase = new TaskChatUseCase(assist, [detailTool, searchTool])
    const reply = await useCase.execute(VALID_INPUT)
    expect(reply.scope).toEqual({ type: 'task', taskId: 't2' })
    expect(reply.actions).toEqual([
      { type: 'tag', taskId: 't2', tags: ['urgente'] },
      { type: 'reorder', taskIds: ['t3', 't4'] },
    ])
  })

  it('sin ninguna llamada a tools, se comporta igual que antes: sólo cuentan los ids del request', async () => {
    const assist = {
      async execute(): Promise<AssistResult> {
        return { fields: { reply: 'ok', scope: { type: 'task', taskId: 't2' }, actions: [] } }
      },
    } as unknown as AssistWithAiUseCase
    const useCase = new TaskChatUseCase(assist, [detailTool, searchTool])
    const reply = await useCase.execute(VALID_INPUT)
    // t2 nunca se leyó con ninguna tool en este turno — el modelo lo puso en
    // `scope` como texto generado, así que verify() lo descarta igual que
    // antes de esta feature.
    expect(reply.scope).toEqual({ type: 'project' })
  })
})
