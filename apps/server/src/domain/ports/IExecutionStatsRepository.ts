import type { AgentDetail, ExecutionStats, ExecutionStatsFilters } from '@ia-flow/shared'

/**
 * Read-only aggregate view over execution history.
 *
 * Deliberately separate from `IExecutionLogRepository` instead of another
 * method on it: that port is the WRITE path, and it has four decorators
 * (broadcasting, source-tagging, composite, remote-forwarding) that would all
 * have to grow a passthrough for a method none of them has any business
 * intercepting. Aggregates are also only ever meaningful against the local
 * database — the remote mirror in the composite is write-only.
 */
export interface IExecutionStatsRepository {
  stats(filters: ExecutionStatsFilters): ExecutionStats
  /** Drill-down for one agent. Returns null when the agent has no finished
   *  runs in the window — the caller renders "nothing here" rather than an
   *  agent-shaped object full of zeros. */
  agentDetail(agentId: string, filters: ExecutionStatsFilters): AgentDetail | null
}
