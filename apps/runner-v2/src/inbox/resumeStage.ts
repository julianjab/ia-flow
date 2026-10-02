/**
 * A qué columna vuelve una tarea que se trabó: la etapa en la que corría la ejecución que falló.
 * Pura: lee lo que el runner ya guardó (los eventos de la task y a qué ejecución llevó cada uno),
 * no pregunta nada a GitHub. Si no la puede determinar devuelve `undefined` y quien llama decide:
 * adivinarla movería la tarea a una etapa que nadie pidió.
 */
import type { EventLogEntry } from '@ia-flow/shared'
import type { InboxSettings } from './InboxSection.js'

/**
 * @param events los eventos de la task, del más nuevo al más viejo
 * @param executionId la ejecución que cerró mal
 *
 * 1. El evento que arrancó esa ejecución, si fue un cambio de columna (`to` = la etapa).
 * 2. Si la arrancó otra cosa (un comentario, el CI), el último cambio de columna anterior a una de
 *    las etapas con agente — nunca `Blocked` ni una columna que la bandeja no conoce.
 */
export function resumeStage(
  events: EventLogEntry[],
  executionId: string | undefined,
  statuses: Pick<InboxSettings['statuses'], 'refine' | 'build' | 'review'>,
): string | undefined {
  const stages = new Set([statuses.refine, statuses.build, statuses.review])
  const stageOf = (entry: EventLogEntry) => {
    const to = entry.summary.to
    return typeof to === 'string' && stages.has(to) ? to : undefined
  }
  const started = executionId
    ? events.find((entry) => entry.execution_id === executionId && stageOf(entry))
    : undefined
  if (started) return stageOf(started)
  return events.map(stageOf).find((stage) => stage !== undefined)
}
