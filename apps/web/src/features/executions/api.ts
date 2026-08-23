import {
  type AgentDetail,
  AgentDetailSchema,
  type ExecutionLog,
  ExecutionLogArraySchema,
  type ExecutionLogFilters,
  ExecutionLogSchema,
  type ExecutionStats,
  type ExecutionStatsFilters,
  ExecutionStatsSchema,
} from '@ia-flow/shared'
import axios from 'axios'

// Thin wrapper around GET /api/executions. Server accepts the same filters
// shape as ExecutionLogFiltersSchema (projectId, taskId, agentId, outcome,
// from, to, limit) and returns `{ executions: ExecutionLog[] }`. We revalidate
// the array here so the component can trust the payload shape.
export async function fetchExecutions(filters: ExecutionLogFilters): Promise<ExecutionLog[]> {
  const { data } = await axios.get<{ executions: unknown }>('/api/executions', {
    params: filters,
    // Repeat-key serializer so Hono's queries(key) sees an array for
    // multi-select filters (agentId, providerId, outcome).
    paramsSerializer: { indexes: null },
  })
  return ExecutionLogArraySchema.parse(data.executions)
}

// Live-only feed used by the dashboard / topbar chip. Server returns just the
// rows where finished_at IS NULL, most recent first.
export async function fetchActiveExecutions(): Promise<ExecutionLog[]> {
  const { data } = await axios.get<{ executions: unknown }>('/api/executions/active')
  return ExecutionLogArraySchema.parse(data.executions)
}

// Distinct `source` values ever recorded (the IA_FLOW_INSTANCE_ID of each
// headless container that has run an agent) — powers the "container" filter
// chip row, same idea as fetchServerLogSources for the Logs tab.
export async function fetchExecutionSources(): Promise<string[]> {
  const { data } = await axios.get<{ sources: unknown }>('/api/executions/sources')
  return Array.isArray(data.sources)
    ? data.sources.filter((s): s is string => typeof s === 'string')
    : []
}

export interface CancelExecutionResult {
  ok: boolean
  alreadyFinished?: boolean
  orphaned?: boolean
  cancelRequested?: boolean
  execution: ExecutionLog
}

// POST /api/executions/:id/cancel — see apps/server/src/routes/executions.ts
// for the branches this can hit: in-flight cancel, orphan cleanup,
// already-finished no-op (ok + alreadyFinished), or — when the execution is
// owned by another daemon (execution.source set) — an advisory mark instead
// of a real cancel (ok + cancelRequested; the container keeps running).
export async function cancelExecution(id: string): Promise<CancelExecutionResult> {
  const { data } = await axios.post<{
    ok: boolean
    alreadyFinished?: boolean
    orphaned?: boolean
    cancelRequested?: boolean
    execution: unknown
  }>(`/api/executions/${id}/cancel`)
  return {
    ok: data.ok,
    alreadyFinished: data.alreadyFinished,
    orphaned: data.orphaned,
    cancelRequested: data.cancelRequested,
    execution: ExecutionLogSchema.parse(data.execution),
  }
}

// GET /api/executions/stats — per-agent health over a window, aggregated in
// SQL. Deliberately NOT derived from fetchExecutions(): that returns one
// capped page, and a success rate computed from the most recent 100 rows
// describes those 100 rows, not the agent.
export async function fetchExecutionStats(filters: ExecutionStatsFilters): Promise<ExecutionStats> {
  const { data } = await axios.get<unknown>('/api/executions/stats', {
    params: filters,
    paramsSerializer: { indexes: null },
  })
  return ExecutionStatsSchema.parse(data)
}

// GET /api/executions/stats/:agentId — the decomposition behind one panel
// row. Returns null on 404, which the server sends when the agent has no
// finished runs in the window (an empty detail, not an error to shout about).
export async function fetchAgentDetail(
  agentId: string,
  filters: ExecutionStatsFilters,
): Promise<AgentDetail | null> {
  try {
    const { data } = await axios.get<unknown>(
      `/api/executions/stats/${encodeURIComponent(agentId)}`,
      { params: filters, paramsSerializer: { indexes: null } },
    )
    return AgentDetailSchema.parse(data)
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null
    throw err
  }
}

// Re-export so ExecutionsSection.vue doesn't need to import from @ia-flow/shared
// directly — feature-local types keep the import graph flat.
export type {
  AgentDetail,
  ExecutionLog,
  ExecutionLogFilters,
  ExecutionStats,
  ExecutionStatsFilters,
}
