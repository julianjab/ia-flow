import {
  type ExecutionLog,
  ExecutionLogArraySchema,
  type ExecutionLogFilters,
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

// Re-export so ExecutionsSection.vue doesn't need to import from @ia-flow/shared
// directly — feature-local types keep the import graph flat.
export type { ExecutionLog, ExecutionLogFilters }
