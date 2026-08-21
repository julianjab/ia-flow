import type { ExecutionLog, ExecutionLogFilters } from '@ia-flow/shared'
import type { IBroadcast } from '../../domain/ports/IBroadcast.js'
import type { IExecutionLogRepository } from '../../domain/ports/IExecutionLogRepository.js'

// Decorator: wraps a real IExecutionLogRepository and pushes an `execution:*`
// event over the shared broadcast channel after each mutation. Keeping the
// broadcast side-effect out of the SQLite class lets tests exercise the DB
// without a WebSocket, and out of the orchestrator so the ~9 update sites
// stay a single line each.
export class BroadcastingExecutionLogRepository implements IExecutionLogRepository {
  constructor(
    private inner: IExecutionLogRepository,
    private broadcast: IBroadcast,
  ) {}

  insert(entry: ExecutionLog): void {
    this.inner.insert(entry)
    const fresh = this.inner.getById(entry.id) ?? entry
    this.broadcast.send({ type: 'execution:started', log: fresh })
  }

  update(id: string, patch: Partial<ExecutionLog>): void {
    this.inner.update(id, patch)
    const fresh = this.inner.getById(id)
    if (fresh) this.broadcast.send({ type: 'execution:updated', log: fresh })
  }

  list(filters: ExecutionLogFilters): ExecutionLog[] {
    return this.inner.list(filters)
  }

  listActive(): ExecutionLog[] {
    return this.inner.listActive()
  }

  getById(id: string): ExecutionLog | null {
    return this.inner.getById(id)
  }

  sweepOrphaned(reason: string): number {
    // Boot-time cleanup — no live clients yet, so skip the per-row broadcast
    // even if this ever runs later. Callers that need realtime updates
    // should call update() individually.
    return this.inner.sweepOrphaned(reason)
  }

  listDistinctSources(): string[] {
    return this.inner.listDistinctSources()
  }
}
