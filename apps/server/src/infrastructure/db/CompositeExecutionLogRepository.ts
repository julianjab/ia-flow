import type { ExecutionLog, ExecutionLogFilters } from '@ia-flow/shared'
import type { IExecutionLogRepository } from '../../domain/ports/IExecutionLogRepository.js'
import { createLogger } from '../../logger.js'

const log = createLogger('execution-log-composite')

// Fans a write out to every composed repo — mirrors how logger.ts always
// writes locally AND fires the remote forward when IA_FLOW_REMOTE_LOG_URL is
// set. `repos[0]` is treated as the source of truth for reads (list/get/…):
// remote repos in this list are write-only forwards, not queryable mirrors,
// same as the logger's remote sink is write-only.
//
// Each repo's write is isolated in its own try/catch: a failing remote POST
// must never stop the local SQLite write (or vice versa) — that's the
// "fallback to local" behavior for headless containers with no network path
// to the host.
export class CompositeExecutionLogRepository implements IExecutionLogRepository {
  private primary: IExecutionLogRepository

  constructor(private repos: IExecutionLogRepository[]) {
    const [primary] = repos
    if (!primary) throw new Error('CompositeExecutionLogRepository requires at least one repo')
    this.primary = primary
  }

  private fanOut(op: string, fn: (repo: IExecutionLogRepository) => void): void {
    for (const repo of this.repos) {
      try {
        fn(repo)
      } catch (err) {
        log.warn({ err, op }, 'One of the composed execution log repos failed')
      }
    }
  }

  insert(entry: ExecutionLog): void {
    this.fanOut('insert', (repo) => repo.insert(entry))
  }

  update(id: string, patch: Partial<ExecutionLog>): void {
    this.fanOut('update', (repo) => repo.update(id, patch))
  }

  list(filters: ExecutionLogFilters): ExecutionLog[] {
    return this.primary.list(filters)
  }

  listActive(): ExecutionLog[] {
    return this.primary.listActive()
  }

  getById(id: string): ExecutionLog | null {
    return this.primary.getById(id)
  }

  sweepOrphaned(reason: string): number {
    return this.primary.sweepOrphaned(reason)
  }

  listDistinctSources(): string[] {
    return this.primary.listDistinctSources()
  }
}
