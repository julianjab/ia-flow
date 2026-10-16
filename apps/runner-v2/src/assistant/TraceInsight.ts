/**
 * Lo que el asistente lee de las trazas más allá de una ejecución por vez: buscar un texto en las
 * de TODAS las ejecuciones guardadas ("¿cuáles fueron los pause_turn del provider anthropic?"),
 * cuándo fue el último paso de una ejecución viva ("¿sigue avanzando?"), y cada agente de una
 * ejecución por separado — en un grupo paralelo (`reviewer` + `e2e-visual-qa`) corren todos dentro
 * de LA MISMA ejecución y su traza sale mezclada. La implementa `SqliteTraceInsight` (storage/).
 */
import type { ExecutionSummary } from '@ia-flow/shared'

export type ExecutionStatus = ExecutionSummary['status']

export interface TraceSearchQuery {
  /** Se busca en el nombre, el mensaje de estado y los atributos de cada entrada (sin distinguir
   *  mayúsculas). */
  text: string
  /** Sólo entradas desde / hasta (ISO). */
  since?: string
  until?: string
  /** Sólo entradas de ese agente (`ia.agent.id`, que heredan todos los spans y logs de su paso). */
  agentId?: string
  pipelineId?: string
  status?: ExecutionStatus
  /** Sólo ejecuciones de esa tarea (`owner/repo#n`). */
  taskRef?: string
  /** Sólo ejecuciones de ese proyecto. */
  projectId?: string
  /** Cuántas ejecuciones, como mucho. */
  limit: number
  /** Cuántas entradas de muestra por ejecución. */
  samples: number
}

export interface TraceSearchSample {
  /** La posición en la traza de su ejecución (0 = la primera), la misma de `assistant_get_trace`. */
  index: number
  name: string
  at: string
  agent?: string
  /** Un pedazo alrededor de lo que coincidió. */
  excerpt: string
}

export interface TraceSearchHit {
  execution_id: string
  task_ref?: string
  project_id?: string
  pipeline_id: string
  status: ExecutionStatus
  started_at: string
  /** Los agentes de las entradas que coinciden. */
  agents: string[]
  matches: number
  samples: TraceSearchSample[]
}

export interface TraceSearchResult {
  executions: TraceSearchHit[]
  /** Hay más ejecuciones que coinciden que las que vinieron. */
  truncated: boolean
}

/** La última corrida de un agente dentro de una ejecución, según su span `agent <id>`. */
export interface AgentRun {
  agent_id: string
  started_at: string
  /** Sin `ended_at`, su span no cerró: sigue corriendo (o la corrida se cortó sin cerrarlo). */
  ended_at?: string
  status?: 'ok' | 'error' | 'unset'
  exit?: string
  summary?: string
  failure?: string
  /** Pausó esperando un evento. */
  waiting?: string
  /** Cedió su turno (lo interrumpieron). */
  interrupted_by?: string
  /** Lo último que dejó en la traza cualquier cosa de ese agente (una tool, un request al modelo). */
  last_step_at: string
}

export interface TraceInsight {
  search(query: TraceSearchQuery): TraceSearchResult
  /** El instante (ISO) de la última entrada de cada ejecución; las que no tienen traza, no están. */
  lastStepAt(executionIds: readonly string[]): Map<string, string>
  /** Cada agente que corrió en la ejecución, en el orden en que arrancó. */
  agentRuns(executionId: string): AgentRun[]
}
