// Tools de sólo lectura para el asistente de chat — consultar issues del
// proyecto sin pasar por el pipeline de despacho de agentes (sin task_id de
// un run activo, sin PendingTask).
//
// DELIBERADAMENTE no llaman a `registerTool()`: el registry compartido de
// `engine.ts` no tiene noción de "sólo para el asistente" — cualquier tool
// registrada ahí queda disponible para `getToolDefinitions()` y por lo tanto
// para cualquier `AgentDefinition` del engine que la declare en `tools[]`.
// Mantenerlas fuera del registry es lo que garantiza que ningún agente del
// engine pueda verlas ni llamarlas — el consumidor (el asistente de chat) las
// importa directo desde este módulo y las ejecuta él mismo.
//
// Consumption model: el `ProjectReadPort` se wirea vía `setProjectReadPort`
// desde `composition/container.ts` al arrancar — mismo patrón que
// `setWorkspaceManagerPort` / `setRepoResolverPort`.

import type { IssueItem } from '@ia-flow/issue-sources'
import type { ProjectReadPort } from '../contract.js'

let projectRead: ProjectReadPort | null = null

/** Wirea el `ProjectReadPort` que estas tools consultan. Llamado desde
 *  `composition/container.ts` al arrancar, y desde tests con un stub/null. */
export function setProjectReadPort(port: ProjectReadPort | null): void {
  projectRead = port
}

/** Test/introspection helper. */
export function getProjectReadPort(): ProjectReadPort | null {
  return projectRead
}

function requirePort(): ProjectReadPort {
  if (!projectRead) {
    throw new Error('ProjectReadPort no está wireado en este runtime')
  }
  return projectRead
}

/** Forma mínima que necesita un consumidor del asistente de chat: nombre,
 *  descripción, schema de input y ejecución. A propósito NO es el `Tool` del
 *  engine (`contract.ts`) — ese tipo trae `specialize`/`hideWhen`/
 *  `providerKinds`, mecánica pensada para el registry compartido que estas
 *  tools nunca integran. */
export interface ReadOnlyTool<TInput = unknown> {
  name: string
  description: string
  input_schema: object
  execute(input: TInput): Promise<string>
}

// Tope duro sobre lo que se manda al modelo de una sola llamada. Un board
// con cientos de items, cada uno con título/repos/labels/assignees/url,
// indentado a 2 espacios, puede desbordar la ventana de contexto del
// asistente o encarecer cada turno — así que se corta y se avisa en vez de
// volcar todo.
const MAX_RESULTS = 50

interface TaskListResult {
  tasks: TaskSummary[]
  total: number
  truncated: boolean
}

function limitResults(items: IssueItem[]): TaskListResult {
  return {
    tasks: items.slice(0, MAX_RESULTS).map(summarize),
    total: items.length,
    truncated: items.length > MAX_RESULTS,
  }
}

interface TaskSummary {
  id: string
  title: string
  status: string
  priority?: string
  repos: string[]
  assignees: string[]
  labels: string[]
  url?: string
}

function summarize(issue: IssueItem): TaskSummary {
  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    priority: typeof issue.meta?.priority === 'string' ? issue.meta.priority : undefined,
    repos: issue.repos,
    assignees: issue.assignees ?? [],
    labels: issue.labels ?? [],
    url: issue.issueUrl,
  }
}

interface GetTaskDetailInput {
  project_id: string
  task_id: string
}

export const getTaskDetail: ReadOnlyTool<GetTaskDetailInput> = {
  name: 'get_task_detail',
  description:
    'Devuelve el detalle completo de un issue del proyecto: título, descripción, status, assignees, labels, URL y comentarios. Sólo lectura — no requiere un run activo.',
  input_schema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'ID del proyecto de ia-flow.' },
      task_id: { type: 'string', description: 'ID source-nativo del issue.' },
    },
    required: ['project_id', 'task_id'],
  },
  async execute(input: GetTaskDetailInput): Promise<string> {
    const port = requirePort()
    const issue = await port.getItem(input.project_id, input.task_id)
    if (!issue) {
      return `No se encontró ningún issue con id '${input.task_id}' en el proyecto '${input.project_id}'.`
    }
    const comments = await port.loadComments(input.project_id, issue)
    return JSON.stringify(
      { ...summarize(issue), description: issue.description, comments },
      null,
      2,
    )
  },
}

interface ListTasksInput {
  project_id: string
}

export const listTasks: ReadOnlyTool<ListTasksInput> = {
  name: 'list_tasks',
  description: `Lista los items del proyecto (priority, status, repos, assignees, labels), sin requerir un run activo. Sólo lectura. Corta a los primeros ${MAX_RESULTS} (\`truncated: true\` + \`total\` cuando hay más) — usá search_tasks para acotar por texto.`,
  input_schema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'ID del proyecto de ia-flow.' },
    },
    required: ['project_id'],
  },
  async execute(input: ListTasksInput): Promise<string> {
    const port = requirePort()
    const items = await port.listItems(input.project_id)
    return JSON.stringify(limitResults(items), null, 2)
  },
}

interface SearchTasksInput {
  project_id: string
  query: string
}

export const searchTasks: ReadOnlyTool<SearchTasksInput> = {
  name: 'search_tasks',
  description: `Busca items del proyecto cuyo título o descripción contenga el query (case-insensitive, obligatorio — no lista el board entero). Filtra en memoria sobre getItems() — no hace ningún request extra al source. Sólo lectura. Corta a los primeros ${MAX_RESULTS} matches (\`truncated: true\` + \`total\` cuando hay más).`,
  input_schema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'ID del proyecto de ia-flow.' },
      query: { type: 'string', description: 'Texto a buscar en título o descripción.' },
    },
    required: ['project_id', 'query'],
  },
  async execute(input: SearchTasksInput): Promise<string> {
    const port = requirePort()
    const q = input.query.trim().toLowerCase()
    if (!q) {
      throw new Error("'query' no puede estar vacío — para listar todo el board usá list_tasks.")
    }
    const items = await port.listItems(input.project_id)
    const matches = items.filter(
      (i) => i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
    )
    return JSON.stringify(limitResults(matches), null, 2)
  },
}

/** Las tres tools de lectura, para que el asistente de chat las importe de un
 *  solo lugar sin tener que nombrarlas una por una. */
export const CHAT_ASSISTANT_READ_TOOLS: ReadOnlyTool[] = [
  getTaskDetail as ReadOnlyTool,
  listTasks as ReadOnlyTool,
  searchTasks as ReadOnlyTool,
]
