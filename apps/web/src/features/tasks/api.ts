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
