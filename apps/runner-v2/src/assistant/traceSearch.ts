/**
 * `assistant_search_traces`: un texto en las trazas de TODAS las ejecuciones guardadas, para las
 * preguntas que cruzan tareas ("¿los agentes dejan memoria?", "¿cuáles fueron los pause_turn del
 * provider anthropic?") sin ir ejecución por ejecución. Acá se valida el pedido y se le ponen los
 * topes; la consulta es de `TraceInsight`.
 */
import type { ExecutionStatus, TraceInsight, TraceSearchQuery } from './TraceInsight.js'

/** Tope duro de ejecuciones por búsqueda: el resultado va entero al contexto del modelo. */
export const TRACE_SEARCH_MAX_LIMIT = 50
export const TRACE_SEARCH_LIMIT = 20
/** Entradas de muestra por ejecución. */
export const TRACE_SEARCH_SAMPLES = 3

export interface SearchTracesInput {
  text: string
  since?: string
  until?: string
  agent_id?: string
  pipeline_id?: string
  status?: ExecutionStatus
  limit?: number
}

function isoOrThrow(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const at = Date.parse(value)
  if (Number.isNaN(at)) throw new Error(`\`${name}\` tiene que ser una fecha ISO, no "${value}"`)
  return new Date(at).toISOString()
}

/** La búsqueda con los topes y el contexto (`scope`: la tarea o el proyecto) que impone el runner. */
export function searchTraces(
  traces: TraceInsight | undefined,
  input: SearchTracesInput,
  scope: Pick<TraceSearchQuery, 'taskRef' | 'projectId'>,
) {
  if (!traces) throw new Error('Este runner no guarda las trazas en una base: no hay qué buscar')
  const text = input.text.trim()
  if (text.length < 2) throw new Error('La búsqueda necesita un texto de al menos 2 caracteres')
  const since = isoOrThrow('since', input.since)
  const until = isoOrThrow('until', input.until)
  const limit = Math.min(Math.max(input.limit ?? TRACE_SEARCH_LIMIT, 1), TRACE_SEARCH_MAX_LIMIT)
  const result = traces.search({
    text,
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(input.agent_id ? { agentId: input.agent_id } : {}),
    ...(input.pipeline_id ? { pipelineId: input.pipeline_id } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...scope,
    limit,
    samples: TRACE_SEARCH_SAMPLES,
  })
  const total = result.executions.reduce((sum, hit) => sum + hit.matches, 0)
  return {
    ...result,
    note: `${result.executions.length} ejecuciones${result.truncated ? ` (hay más: acotá con since/until, agent_id, pipeline_id o status, o subí limit hasta ${TRACE_SEARCH_MAX_LIMIT})` : ''}, ${total} entradas que coinciden; de cada una, hasta ${TRACE_SEARCH_SAMPLES} de muestra. El detalle de una: assistant_get_trace con su execution_id y \`contains\`.`,
  }
}
