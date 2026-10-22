import {
  type AddToBoardRequest,
  type AddToBoardResult,
  AddToBoardResultSchema,
  type BoardRest,
  BoardRestSchema,
  type EpicDetail,
  EpicDetailSchema,
  type ExplainResult,
  ExplainResultSchema,
  type Inbox,
  InboxSchema,
  type MoveTaskRequest,
  type TaskActionRequest,
  type TaskActionResult,
  TaskActionResultSchema,
  type TaskDetail,
  TaskDetailSchema,
  type Tasks,
  TasksSchema,
} from '@ia-flow/shared'
import axios from 'axios'

const REF_RE = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/

/** `owner/repo#n` → el path de la tarea. Falla fuerte con una ref mal formada. */
export function taskPath(ref: string): string {
  const m = REF_RE.exec(ref)
  if (!m) throw new Error(`Referencia de tarea inválida: ${ref}`)
  return `/api/tasks/${encodeURIComponent(m[1] as string)}/${encodeURIComponent(m[2] as string)}/${m[3]}`
}

export async function getInbox(project?: string): Promise<Inbox> {
  const { data } = await axios.get<unknown>('/api/inbox', {
    params: project ? { project } : undefined,
  })
  return InboxSchema.parse(data)
}

/**
 * Los hechos de cada tarea, sin clasificar: qué es una decisión lo dice el dashboard de este
 * runner (`view/`). Un runner que todavía no los publica (404) devuelve `null`: la bandeja cae a
 * `/api/inbox`, ya clasificado por el runner.
 */
export async function getTasks(project?: string): Promise<Tasks | null> {
  const res = await axios.get<unknown>('/api/tasks', {
    params: project ? { project } : undefined,
    validateStatus: (status) => status < 500,
  })
  if (res.status === 404) return null
  if (res.status >= 400) throw new Error(`El runner respondió ${res.status} en /api/tasks`)
  return TasksSchema.parse(res.data)
}

/** Lo que la bandeja no muestra, por columna: se pide al abrir «Resto del board». */
export async function getBoardRest(project?: string): Promise<BoardRest> {
  const { data } = await axios.get<unknown>('/api/board', {
    params: project ? { project } : undefined,
  })
  return BoardRestSchema.parse(data)
}

export async function getTaskDetail(ref: string, executionId?: string): Promise<TaskDetail> {
  const { data } = await axios.get<unknown>(taskPath(ref), {
    params: executionId ? { execution: executionId } : undefined,
  })
  return TaskDetailSchema.parse(data)
}

/** Una épica con todos sus sub-issues (su columna, si están en el board): la que abre su chip. */
export async function getEpic(ref: string): Promise<EpicDetail> {
  const { data } = await axios.get<unknown>(`${taskPath(ref)}/epic`)
  return EpicDetailSchema.parse(data)
}

/** Un pedido firmado con el token de GitHub del usuario: un 4xx vuelve como respuesta, no se lanza. */
const signedBy = (githubToken: string) => ({
  headers: { 'x-github-token': githubToken },
  validateStatus: (status: number) => status < 500,
})

interface ResultSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false }
}

/** El resultado de un pedido firmado: el rechazo del runner (`ok: false`) también tiene esta forma. */
function signedResult<T>(schema: ResultSchema<T>, res: { status: number; data: unknown }): T {
  const parsed = schema.safeParse(res.data)
  if (parsed.success) return parsed.data
  throw new Error(`El runner respondió ${res.status} sin un resultado legible`)
}

/**
 * Ejecuta una acción sobre una tarea, firmada con el token de GitHub del
 * USUARIO (`x-github-token`), como mover o agregar una card al board.
 *
 * Un rechazo del runner (403 sin permisos, 409 la tarea cambió…) llega con el
 * mismo cuerpo `TaskActionResult` y `ok: false`: se devuelve para mostrar su
 * mensaje. Sólo lo que no tiene esa forma se lanza.
 */
export async function postTaskAction(
  ref: string,
  request: TaskActionRequest,
  githubToken: string,
): Promise<TaskActionResult> {
  const res = await axios.post<unknown>(`${taskPath(ref)}/actions`, request, signedBy(githubToken))
  return signedResult(TaskActionResultSchema, res)
}

/**
 * Mueve la card a otra columna del board, firmado con el token del usuario. Como una acción: un
 * rechazo (409 si un agente la está corriendo o ya está ahí) vuelve con `ok: false` y su mensaje.
 */
export async function postTaskStatus(
  ref: string,
  status: string,
  githubToken: string,
): Promise<TaskActionResult> {
  const body: MoveTaskRequest = { status }
  const res = await axios.post<unknown>(`${taskPath(ref)}/status`, body, signedBy(githubToken))
  return signedResult(TaskActionResultSchema, res)
}

/**
 * Agrega al board un issue que no está (`owner/repo#n` o su link), en `status` o —sin él— en Todo.
 * Un rechazo (409 si ya está, 400 si es un PR…) vuelve con `ok: false` y su mensaje.
 */
export async function postBoardItem(
  request: AddToBoardRequest,
  githubToken: string,
): Promise<AddToBoardResult> {
  const res = await axios.post<unknown>('/api/board/items', request, signedBy(githubToken))
  return signedResult(AddToBoardResultSchema, res)
}

/** "¿Por qué no corrió?": las decisiones del engine para un evento contra la card. */
export async function explainTask(ref: string, event?: string): Promise<ExplainResult> {
  const { data } = await axios.get<unknown>('/api/explain', {
    params: event ? { ref, event } : { ref },
  })
  return ExplainResultSchema.parse(data)
}
