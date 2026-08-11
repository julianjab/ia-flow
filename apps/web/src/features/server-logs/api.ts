import { type ServerLogEntry, ServerLogEntrySchema, type ServerLogFilters } from '@ia-flow/shared'
import axios from 'axios'
import { z } from 'zod'

// Thin wrapper around GET /api/server-logs. Server accepts the same filters
// shape as ServerLogFiltersSchema (level, module, search, from, to, limit,
// offset) and returns `{ entries: ServerLogEntry[], total: number }`. We
// revalidate the entries here so the component can trust the payload shape.
export async function fetchServerLogs(
  filters: ServerLogFilters,
): Promise<{ entries: ServerLogEntry[]; total: number }> {
  const { data } = await axios.get<{ entries: unknown; total: number }>('/api/server-logs', {
    params: filters,
  })
  return {
    entries: z.array(ServerLogEntrySchema).parse(data.entries),
    total: typeof data.total === 'number' ? data.total : 0,
  }
}

// Re-export so ServerLogsSection.vue doesn't need to import from
// @ia-flow/shared directly — feature-local types keep the import graph flat.
export type { ServerLogEntry, ServerLogFilters }
