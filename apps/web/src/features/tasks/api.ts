import type { SlackMemberRef } from '@ia-flow/shared'
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

/** Lo que devuelve "correr ahora": qué hizo el bus con el evento. */
export interface RunTaskNowResult {
  /** `dispatched` = una regla lo tomó · `skipped` = ninguna matcheó ·
   *  `deferred` = matchearon pero no hay capacidad ahora. */
  outcome: 'dispatched' | 'skipped' | 'deferred'
  /** El status contra el que se evaluaron las reglas. */
  status: string
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
  const { data } = await axios.post<RunTaskNowResult>(
    `/api/tasks/${encodeURIComponent(taskId)}/run`,
    { projectId },
  )
  return data
}
