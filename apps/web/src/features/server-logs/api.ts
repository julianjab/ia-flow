import {
  type ServerLogEntry,
  ServerLogEntrySchema,
  type ServerLogFilters,
  type ServerLogLevel,
} from '@ia-flow/shared'
import axios from 'axios'
import { z } from 'zod'

export type ServerLogLevelCounts = Record<ServerLogLevel, number>

const LevelCountsSchema = z.object({
  trace: z.number(),
  debug: z.number(),
  info: z.number(),
  warn: z.number(),
  error: z.number(),
  fatal: z.number(),
})

// Thin wrapper around GET /api/server-logs. Server accepts the same filters
// shape as ServerLogFiltersSchema (level, module, search, from, to, limit,
// offset, sort, sortBy) and returns `{ entries, total, levelCounts }`.
// `levelCounts` is the breakdown across the FULL filtered set (ignoring
// the `level` filter itself) so the UI can show a stable summary regardless
// of pagination or which level is active.
export async function fetchServerLogs(
  filters: ServerLogFilters,
): Promise<{ entries: ServerLogEntry[]; total: number; levelCounts: ServerLogLevelCounts }> {
  const { data } = await axios.get<{
    entries: unknown
    total: number
    levelCounts?: unknown
  }>('/api/server-logs', {
    params: filters,
    // Axios' default array serializer emits `module[]=a&module[]=b`, which
    // Hono won't group under the `module` key. Use the repeated-key form so
    // c.req.queries('module') sees ['a', 'b'].
    paramsSerializer: {
      indexes: null,
    },
  })
  const parsedCounts = LevelCountsSchema.safeParse(data.levelCounts)
  return {
    entries: z.array(ServerLogEntrySchema).parse(data.entries),
    total: typeof data.total === 'number' ? data.total : 0,
    levelCounts: parsedCounts.success
      ? parsedCounts.data
      : { trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0 },
  }
}

// Distinct module names present anywhere in daemon.log — powers the "all
// modules" multi-select chip row. Cheap to poll: the server tails the log
// once and returns a sorted string[].
export async function fetchServerLogModules(): Promise<string[]> {
  const { data } = await axios.get<{ modules: unknown }>('/api/server-logs/modules')
  return z.array(z.string()).parse(data.modules)
}

// Re-export so ServerLogsSection.vue doesn't need to import from
// @ia-flow/shared directly — feature-local types keep the import graph flat.
export type { ServerLogEntry, ServerLogFilters }
