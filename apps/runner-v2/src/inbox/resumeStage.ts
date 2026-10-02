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
 * 3. Si ningún evento dice la columna (un board de issues puede arrancar una corrida con un label
 *    suelto), el pipeline de esa corrida: `refine`, `build` y `review` se llaman como su etapa.
 */
export function resumeStage(
  events: EventLogEntry[],
  execution: { id: string; pipeline_id: string } | undefined,
  statuses: Pick<InboxSettings['statuses'], 'refine' | 'build' | 'review'>,
): string | undefined {
  const stages = new Set([statuses.refine, statuses.build, statuses.review])
  const stageOf = (entry: EventLogEntry) => {
    const to = entry.summary.to
    return typeof to === 'string' && stages.has(to) ? to : undefined
  }
  const started = execution
    ? events.find((entry) => entry.execution_id === execution.id && stageOf(entry))
    : undefined
  if (started) return stageOf(started)
  const earlier = events.map(stageOf).find((stage) => stage !== undefined)
  if (earlier) return earlier
  return execution ? byPipeline(statuses)[execution.pipeline_id.toLowerCase()] : undefined
}

/** Los pipelines que se llaman como la etapa en la que trabajan. */
const byPipeline = (
  statuses: Pick<InboxSettings['statuses'], 'refine' | 'build' | 'review'>,
): Record<string, string> => ({
  refine: statuses.refine,
  build: statuses.build,
  review: statuses.review,
})
