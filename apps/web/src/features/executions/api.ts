import {
  type ExecutionLog,
  ExecutionLogArraySchema,
  type ExecutionLogFilters,
  ExecutionLogSchema,
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
  execution: ExecutionLog
}

// POST /api/executions/:id/cancel — see apps/server/src/routes/executions.ts
// for the branches this can hit: in-flight cancel, orphan cleanup,
// already-finished no-op (ok + alreadyFinished), or a 409 when the execution
// is owned by another daemon (execution.source set) — that case is left to
// the caller to catch, same as any other axios error.
export async function cancelExecution(id: string): Promise<CancelExecutionResult> {
  const { data } = await axios.post<{
    ok: boolean
    alreadyFinished?: boolean
    orphaned?: boolean
    execution: unknown
  }>(`/api/executions/${id}/cancel`)
  return {
    ok: data.ok,
    alreadyFinished: data.alreadyFinished,
    orphaned: data.orphaned,
    execution: ExecutionLogSchema.parse(data.execution),
  }
}

// Re-export so ExecutionsSection.vue doesn't need to import from @ia-flow/shared
// directly — feature-local types keep the import graph flat.
export type { ExecutionLog, ExecutionLogFilters }
