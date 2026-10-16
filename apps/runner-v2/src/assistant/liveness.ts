/**
 * "¿Sigue avanzando?" para el asistente: la hora del runner, cuánto hace del último paso de una
 * ejecución viva y en qué está cada agente de una ejecución — los de un grupo paralelo corren en
 * LA MISMA ejecución y su traza sale mezclada, así que el resumen de la ejecución (`agent_id`,
 * `exit`, `summary`) sólo cuenta al último que cerró. Puro: los datos los trae `TraceInsight`.
 */
import type { AgentRun, ExecutionStatus, TraceInsight } from './TraceInsight.js'

const LIVE: ReadonlySet<ExecutionStatus> = new Set(['running', 'paused'])

export function isLive(status: ExecutionStatus | undefined): boolean {
  return status !== undefined && LIVE.has(status)
}

/** Segundos enteros desde `iso` hasta `now` (nunca negativos); sin fecha válida, ausente. */
export function secondsSince(iso: string | undefined, now: Date): number | undefined {
  const at = iso ? Date.parse(iso) : Number.NaN
  if (Number.isNaN(at)) return undefined
  return Math.max(Math.round((now.getTime() - at) / 1000), 0)
}

export type AgentState = 'running' | 'waiting' | 'done' | 'failed' | 'interrupted' | 'unfinished'

export interface AgentLane extends AgentRun {
  /** `running`: su span no cerró y la ejecución sigue viva; `unfinished`: no cerró, pero la
   *  ejecución ya terminó (se cortó sin cerrarlo). */
  state: AgentState
  /** Sólo `running`: cuánto hace de su último paso. */
  idle_seconds?: number
}

function stateOf(run: AgentRun, executionLive: boolean): AgentState {
  if (!run.ended_at) return executionLive ? 'running' : 'unfinished'
  if (run.interrupted_by) return 'interrupted'
  if (run.waiting) return 'waiting'
  return run.status === 'error' ? 'failed' : 'done'
}

/** Cada agente de una ejecución con su estado; los que corren, con cuánto hace de su último paso. */
export function agentLanes(
  runs: readonly AgentRun[],
  status: ExecutionStatus,
  now: Date,
): AgentLane[] {
  return runs.map((run) => {
    const state = stateOf(run, isLive(status))
    const idle = state === 'running' ? secondsSince(run.last_step_at, now) : undefined
    return { ...run, state, ...(idle !== undefined ? { idle_seconds: idle } : {}) }
  })
}

/** Lo que se le suma a una ejecución: su último paso si está viva, y sus agentes si se piden. */
export interface ExecutionLiveness {
  last_step_at?: string
  idle_seconds?: number
  agents?: AgentLane[]
}

/**
 * Las ejecuciones con lo que dice si avanzan: las vivas, cuándo fue su último paso (`last_step_at`,
 * `idle_seconds`) y cada agente; de las que `withAgents` elige (p.ej. la última), cada agente
 * también — si corrió más de uno, que es cuando el resumen de la ejecución no alcanza.
 */
export function withLiveness<T extends { id: string; status: ExecutionStatus }>(
  executions: readonly T[],
  traces: TraceInsight | undefined,
  now: Date,
  withAgents: (execution: T, index: number) => boolean = () => false,
): Array<T & ExecutionLiveness> {
  if (!traces) return [...executions]
  const live = executions.filter((execution) => isLive(execution.status))
  const lastAt = traces.lastStepAt(live.map((execution) => execution.id))
  return executions.map((execution, index) => {
    const out: T & ExecutionLiveness = { ...execution }
    const executionLive = isLive(execution.status)
    if (executionLive) {
      const last = lastAt.get(execution.id)
      const idle = secondsSince(last, now)
      if (last) out.last_step_at = last
      if (idle !== undefined) out.idle_seconds = idle
    }
    if (executionLive || withAgents(execution, index)) {
      const lanes = agentLanes(traces.agentRuns(execution.id), execution.status, now)
      if (executionLive ? lanes.length > 0 : lanes.length > 1) out.agents = lanes
    }
    return out
  })
}
