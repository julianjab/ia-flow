// Tools de lectura cross-task para el registry COMPARTIDO — a diferencia de
// `task-read.ts` (pensadas sólo para `AssistWithAiUseCase`, deliberadamente
// fuera de `registerTool()`), estas SÍ pasan por acá: el asistente
// conversacional es un `AgentDefinition` real, así que sus tools salen del
// mismo registro que cualquier otro agente.
import type { ProjectListPort, ProjectReadPort, ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'

let projectRead: ProjectReadPort | null = null
let projectList: ProjectListPort | null = null

/** Wireado desde `composition/container.ts` al arrancar. */
export function setAssistantProjectPorts(ports: {
  read: ProjectReadPort | null
  list: ProjectListPort | null
}): void {
  projectRead = ports.read
  projectList = ports.list
}

// Mismo tope que `task-read.ts` — un board con cientos de items puede
// desbordar la ventana de contexto del asistente si se manda entero.
const MAX_RESULTS = 50

registerTool({
  name: 'list_projects',
  description:
    'Lista los proyectos de ia-flow (id + nombre). Usala cuando no sepas de qué proyecto habla el operador, antes de llamar cualquier tool que pida project_id.',
  input_schema: { type: 'object', properties: {} },
  async execute(_input: unknown, _ctx?: ToolContext): Promise<string> {
    if (!projectList) return 'No hay proyectos disponibles en este runtime.'
    return JSON.stringify(await projectList.list(), null, 2)
  },
})

registerTool({
  name: 'assistant_get_task_detail',
  description:
    'Devuelve el detalle completo de un issue: título, descripción, status, repos, labels y comentarios. Sólo lectura.',
  input_schema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'ID del proyecto de ia-flow.' },
      task_id: { type: 'string', description: 'ID source-nativo del issue.' },
    },
    required: ['project_id', 'task_id'],
  },
  async execute(input: unknown, _ctx?: ToolContext): Promise<string> {
    if (!projectRead) return 'No hay acceso a proyectos en este runtime.'
    const { project_id, task_id } = input as { project_id: string; task_id: string }
    const issue = await projectRead.getItem(project_id, task_id)
    if (!issue) {
      return `No se encontró ningún issue con id '${task_id}' en el proyecto '${project_id}'.`
    }
    const comments = await projectRead.loadComments(project_id, issue)
    return JSON.stringify({ ...issue, comments }, null, 2)
  },
})

registerTool({
  name: 'assistant_list_tasks',
  description: `Lista los items de un proyecto (título, status, repos, labels), sin filtrar. Sólo lectura. Corta a los primeros ${MAX_RESULTS} — usá assistant_search_tasks para acotar por texto.`,
  input_schema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'ID del proyecto de ia-flow.' },
    },
    required: ['project_id'],
  },
  async execute(input: unknown, _ctx?: ToolContext): Promise<string> {
    if (!projectRead) return 'No hay acceso a proyectos en este runtime.'
    const { project_id } = input as { project_id: string }
    const items = await projectRead.listItems(project_id)
    return JSON.stringify(
      {
        tasks: items.slice(0, MAX_RESULTS),
        total: items.length,
        truncated: items.length > MAX_RESULTS,
      },
      null,
      2,
    )
  },
})

registerTool({
  name: 'assistant_search_tasks',
  description:
    'Busca items de un proyecto cuyo título o descripción contenga el query (case-insensitive, obligatorio). Sólo lectura.',
  input_schema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'ID del proyecto de ia-flow.' },
      query: { type: 'string', description: 'Texto a buscar en título o descripción.' },
    },
    required: ['project_id', 'query'],
  },
  async execute(input: unknown, _ctx?: ToolContext): Promise<string> {
    if (!projectRead) return 'No hay acceso a proyectos en este runtime.'
    const { project_id, query } = input as { project_id: string; query: string }
    const q = query.trim().toLowerCase()
    if (!q) {
      throw new Error(
        "'query' no puede estar vacío — para listar todo el board usá assistant_list_tasks.",
      )
    }
    const items = await projectRead.listItems(project_id)
    const matches = items.filter(
      (i) => i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
    )
    return JSON.stringify(
      {
        tasks: matches.slice(0, MAX_RESULTS),
        total: matches.length,
        truncated: matches.length > MAX_RESULTS,
      },
      null,
      2,
    )
  },
})
