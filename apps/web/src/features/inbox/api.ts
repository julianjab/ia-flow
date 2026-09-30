import {
  type ConfigSummary,
  ConfigSummarySchema,
  type ExplainResult,
  ExplainResultSchema,
  type Inbox,
  InboxSchema,
  type TaskActionRequest,
  type TaskActionResult,
  TaskActionResultSchema,
  type TaskDetail,
  TaskDetailSchema,
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

export async function getTaskDetail(ref: string, executionId?: string): Promise<TaskDetail> {
  const { data } = await axios.get<unknown>(taskPath(ref), {
    params: executionId ? { execution: executionId } : undefined,
  })
  return TaskDetailSchema.parse(data)
}

/**
 * Ejecuta una acción sobre una tarea, firmada con el token de GitHub del
 * USUARIO (`x-github-token`): es el único endpoint que lo lleva.
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
  const res = await axios.post<unknown>(`${taskPath(ref)}/actions`, request, {
    headers: { 'x-github-token': githubToken },
    validateStatus: (status) => status < 500,
  })
  const parsed = TaskActionResultSchema.safeParse(res.data)
  if (parsed.success) return parsed.data
  throw new Error(`El runner respondió ${res.status} sin un resultado legible`)
}

/** "¿Por qué no corrió?": las decisiones del engine para un evento contra la card. */
export async function explainTask(ref: string, event?: string): Promise<ExplainResult> {
  const { data } = await axios.get<unknown>('/api/explain', {
    params: event ? { ref, event } : { ref },
  })
  return ExplainResultSchema.parse(data)
}

export async function getConfig(): Promise<ConfigSummary> {
  const { data } = await axios.get<unknown>('/api/config')
  return ConfigSummarySchema.parse(data)
}
