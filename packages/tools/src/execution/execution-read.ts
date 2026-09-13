import type { ExecutionReadPort, ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'

let executionRead: ExecutionReadPort | null = null

/** Wireado desde `composition/container.ts` al arrancar. */
export function setExecutionReadPort(port: ExecutionReadPort | null): void {
  executionRead = port
}

registerTool({
  name: 'get_execution_history',
  description:
    'Lista las últimas ejecuciones (runs de agentes) de una tarea — outcome, motivo de fallo, cuándo. Usala para "¿cómo va esta tarea?"/"¿qué le pasó?".',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'ID de la tarea (issue) de la que se quiere el historial.',
      },
      limit: {
        type: 'number',
        description: 'Cuántas ejecuciones traer, más recientes primero. Default 10.',
      },
    },
    required: ['task_id'],
  },
  async execute(input: unknown, _ctx?: ToolContext): Promise<string> {
    if (!executionRead) return 'No hay acceso a ejecuciones en este runtime.'
    const { task_id, limit } = input as { task_id: string; limit?: number }
    const rows = executionRead.list({ taskId: task_id, limit: limit ?? 10 })
    if (!rows.length) return `No hay ejecuciones registradas para la tarea '${task_id}'.`
    return JSON.stringify(rows, null, 2)
  },
})

registerTool({
  name: 'get_execution_detail',
  description:
    'Devuelve el detalle de UNA ejecución puntual por su id (outcome, motivo de fallo) — llamá primero get_execution_history para conseguir el id.',
  input_schema: {
    type: 'object',
    properties: {
      execution_id: { type: 'string', description: 'ID de la ejecución.' },
    },
    required: ['execution_id'],
  },
  async execute(input: unknown, _ctx?: ToolContext): Promise<string> {
    if (!executionRead) return 'No hay acceso a ejecuciones en este runtime.'
    const { execution_id } = input as { execution_id: string }
    const row = executionRead.getById(execution_id)
    if (!row) return `No se encontró ninguna ejecución con id '${execution_id}'.`
    return JSON.stringify(row, null, 2)
  },
})
