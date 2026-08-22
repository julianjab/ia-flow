import type { ExecutionLog, ExecutionLogFilters } from '@ia-flow/shared'
import type { IExecutionLogRepository } from '../../domain/ports/IExecutionLogRepository.js'

// Stamps every inserted row with this process's IA_FLOW_INSTANCE_ID before
// handing it to the wrapped repo — the execution_logs analog of logger.ts
// tagging extras.source on every line. Wraps the OUTERMOST repo (local-only
// or a CompositeExecutionLogRepository fanning out to local + remote) so the
// tag is consistent regardless of whether the row ends up local-only (no
// network path to the main daemon) or gets forwarded — see
// composition/container.ts.
export class SourceTaggingExecutionLogRepository implements IExecutionLogRepository {
  constructor(
    private inner: IExecutionLogRepository,
    private source: string,
  ) {}

  insert(entry: ExecutionLog): void {
    this.inner.insert({ ...entry, source: entry.source ?? this.source })
  }

  update(id: string, patch: Partial<ExecutionLog>): void {
    this.inner.update(id, patch)
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

  sweepOrphaned(reason: string): ExecutionLog[] {
    return this.inner.sweepOrphaned(reason)
  }

  flush(): Promise<void> {
    return this.inner.flush?.() ?? Promise.resolve()
  }

  listDistinctSources(): string[] {
    return this.inner.listDistinctSources()
  }
}
