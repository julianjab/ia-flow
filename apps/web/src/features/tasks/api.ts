import {
  type ExecutionLog,
  ExecutionLogArraySchema,
  type RunTaskNowResult,
  RunTaskNowResultSchema,
  type SlackMemberRef,
  type TaskRunPreview,
  TaskRunPreviewSchema,
} from '@ia-flow/shared'
import axios from 'axios'

export interface SlackReviewResult {
  kind: 'first' | 're-review'
  threadUrl?: string
  channel: string
  reviewers: SlackMemberRef[]
  prNumber: number
  /** El pedido salió, pero el link del hilo no se pudo guardar: el próximo va a
   *  abrir un hilo nuevo. Se muestra como warning, no como error. */
  threadNotPersisted?: string
}

/**
 * Pide review del PR de la tarea en Slack.
 *
 * `allowFailedCi` sólo se manda cuando el operador confirmó un CI en rojo — el
 * server lo exige para que un pedido con build roto no salga por accidente
 * desde la API.
 */
export async function requestSlackReview(
  projectId: string,
  taskId: string,
  opts: { allowFailedCi?: boolean } = {},
): Promise<SlackReviewResult> {
  const { data } = await axios.post<SlackReviewResult>(
    `/api/tasks/${encodeURIComponent(taskId)}/slack-review`,
    { projectId, ...(opts.allowFailedCi ? { allowFailedCi: true } : {}) },
  )
  return data
}

/**
 * Vuelve a evaluar las reglas de la tarea contra su status actual, sin tocar
 * el board.
 *
 * Existe porque la activación escucha `issue.created`/`issue.status_changed`:
 * una tarea que se queda quieta en su status no se vuelve a despachar sola, y
 * hasta ahora el único recurso era moverla a otro status y traerla de vuelta.
 */
export async function runTaskNow(projectId: string, taskId: string): Promise<RunTaskNowResult> {
  const { data } = await axios.post(`/api/tasks/${encodeURIComponent(taskId)}/run`, { projectId })
  // `.parse()` y no un cast: si el server suma un cuarto outcome, esto falla
  // acá con el valor a la vista en vez de caer al `else` de la UI y anunciar
  // "ninguna regla matcheó" sobre un run que sí arrancó.
  return RunTaskNowResultSchema.parse(data)
}

/**
 * Los runs de UNA tarea, más recientes primero.
 *
 * La llamada vive acá y no se importa de `features/executions` a propósito:
 * una feature no importa de otra (ver CLAUDE.md). Lo que sí se comparte es el
 * schema, que es de `@ia-flow/shared` — que es exactamente la frontera que la
 * regla protege.
 */
export async function fetchTaskExecutions(
  projectId: string,
  taskId: string,
  limit = 10,
): Promise<ExecutionLog[]> {
  const { data } = await axios.get<{ executions: unknown }>('/api/executions', {
    params: { projectId, taskId, limit },
  })
  return ExecutionLogArraySchema.parse(data.executions)
}

/**
 * Qué pasaría si corrieras la tarea ahora — y si no va a correr, por qué.
 *
 * Es de lectura: el server evalúa las mismas reglas que el motor contra el
 * mismo evento, sin publicar nada.
 */
export async function fetchTaskRunPreview(
  projectId: string,
  taskId: string,
): Promise<TaskRunPreview> {
  const { data } = await axios.get(`/api/tasks/${encodeURIComponent(taskId)}/run-preview`, {
    params: { projectId },
  })
  return TaskRunPreviewSchema.parse(data)
}
