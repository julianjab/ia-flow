/**
 * Qué vuelve a despachar «Reintentar» / «Relanzar» sobre una task, y si eso abriría algo. Puro:
 * lee lo que el runner ya guardó y las decisiones de un dry-run del engine (`explain`).
 */
import type { DispatchDecision } from '@ia-flow/agent-engine'
import type { ActivityPort, StoredEvent } from './ActivityPort.js'

/**
 * Si la última ejecución de la task falló, el evento que la abrió; si no (o no se encuentra), el
 * último que el engine despachó. El último de la task puede ser uno que sólo despertó una pausa
 * de esa ejecución: relanzarlo no abre nada (subscriptions#1977, un `check_suite` en verde).
 */
export function relaunchEvent(
  activity: Pick<ActivityPort, 'executions' | 'lastDispatchedEvent'>,
  ref: string,
): StoredEvent | undefined {
  const last = activity.executions({ taskRef: ref, limit: 1 })[0]
  const opening =
    last?.status === 'failed'
      ? activity.lastDispatchedEvent(ref, {
          pipelineId: last.pipeline_id,
          startedAt: last.started_at,
        })
      : undefined
  return opening ?? activity.lastDispatchedEvent(ref)
}

/** Por qué relanzar `event` no haría nada — ninguna pipeline corre con él —, o `undefined` si
 *  alguna corre. Así la bandeja no contesta «volví a despachar» por un despacho vacío. */
export function noOpReason(event: StoredEvent, decisions: DispatchDecision[]): string | undefined {
  if (decisions.some((decision) => decision.verdict === 'ran')) return undefined
  const why = decisions
    .filter((decision) => decision.reason)
    .slice(0, 3)
    .map((decision) => `${decision.pipelineId}: ${decision.reason}`)
  return `relanzar ${event.type} no abre ninguna pipeline${why.length > 0 ? ` (${why.join('; ')})` : ''} — re-ejecutá la etapa`
}
