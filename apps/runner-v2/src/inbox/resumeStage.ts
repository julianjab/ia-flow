/**
 * A qué columna vuelve una tarea que se trabó: la etapa en la que corría la ejecución que falló.
 * Pura: lee lo que el runner ya guardó (los eventos de la task y a qué ejecución llevó cada uno),
 * no pregunta nada a GitHub. Si no la puede determinar devuelve `undefined` y quien llama decide:
 * adivinarla movería la tarea a una etapa que nadie pidió.
 */
import type { EventLogEntry } from '@ia-flow/shared'
import type { InboxSettings } from './InboxSection.js'

/**
 * El único evento que dice a qué columna se movió LA task. Otros también traen un `to` y quedan
 * guardados bajo la task, pero el `to` es de otro issue: `issue.child_status_changed` lo publica un
 * sub-issue sobre su épica con la columna del hijo, `issue.blockers_refined` el prerrequisito con
 * la suya. Leerlos como la columna de la épica la mandaba a Review con hijos abiertos
 * (ai-mobile-app#818: el hijo pasó a Review y "Responder y destrabar" movió la épica ahí).
 */
const OWN_MOVE = 'issue.status_changed'

/**
 * @param events los eventos de la task, del más nuevo al más viejo
 * @param execution la ejecución que cerró mal
 * @param current la columna en la que está la card ahora
 *
 * 1. El evento que arrancó esa ejecución, si fue un cambio de columna de la task (`to` = la etapa).
 * 2. Si la arrancó otra cosa (un comentario, el CI, un aviso de un hijo), el último cambio de
 *    columna de la task anterior a esa ejecución hacia una de las etapas con agente — nunca
 *    `Blocked` ni una columna que la bandeja no conoce.
 * 3. Si ningún evento lo dice (se fue de la ventana de eventos), la columna en la que sigue la card
 *    si es una etapa: trabarse no la movió, así que destrabarla tampoco.
 * 4. Si tampoco (un board de issues puede arrancar una corrida con un label suelto), el pipeline de
 *    esa corrida: `refine`, `build` y `review` se llaman como su etapa.
 */
export function resumeStage(
  events: EventLogEntry[],
  execution: { id: string; pipeline_id: string } | undefined,
  statuses: Pick<InboxSettings['statuses'], 'refine' | 'build' | 'review'>,
  current?: string,
): string | undefined {
  const stages = new Set([statuses.refine, statuses.build, statuses.review])
  const stageOf = (entry: EventLogEntry) => {
    const to = entry.summary.to
    return entry.type === OWN_MOVE && typeof to === 'string' && stages.has(to) ? to : undefined
  }
  const startedAt = execution
    ? events.findIndex((entry) => entry.execution_id === execution.id)
    : -1
  const started = execution
    ? events.find((entry) => entry.execution_id === execution.id && stageOf(entry))
    : undefined
  if (started) return stageOf(started)
  // Lo que pasó después de que arrancó la ejecución que falló no dice dónde corría.
  const earlier = events
    .slice(Math.max(startedAt, 0))
    .map(stageOf)
    .find((stage) => stage !== undefined)
  if (earlier) return earlier
  if (current && stages.has(current)) return current
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
