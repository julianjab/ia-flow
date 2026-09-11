import type { ProjectWritePort, ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'

let projectWrite: ProjectWritePort | null = null

/** Wireado desde `composition/container.ts` al arrancar. */
export function setProjectWritePort(port: ProjectWritePort | null): void {
  projectWrite = port
}

registerTool({
  name: 'create_task',
  description:
    'Crea una tarea/issue nueva en un proyecto de ia-flow — no tiene por qué ser el proyecto de la tarea activa. Usala cuando el operador pida crear una tarea desde el chat.',
  input_schema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'ID del proyecto de ia-flow donde crearla.' },
      title: { type: 'string', description: 'Título de la tarea.' },
      description: { type: 'string', description: 'Descripción/cuerpo, en markdown.' },
      repo: {
        type: 'string',
        description: 'Opcional — nombre del repo primario, tal como aparece en el proyecto.',
      },
    },
    required: ['project_id', 'title'],
  },
  async execute(input: unknown, _ctx?: ToolContext): Promise<string> {
    if (!projectWrite) return 'No se pueden crear tareas en este runtime.'
    const { project_id, title, description, repo } = input as {
      project_id: string
      title: string
      description?: string
      repo?: string
    }
    const created = await projectWrite.createItem(project_id, {
      title,
      description,
      repos: repo ? [repo] : undefined,
    })
    return JSON.stringify(created, null, 2)
  },
})
