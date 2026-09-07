import type { ExecutionLog, ExecutionLogFilters, TaskRunSummary } from '@ia-flow/shared'
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

  // The sweep is a bulk SQL UPDATE inside the primary — the composed
  // write-only mirrors (RemoteExecutionLogRepository) never see it. Left as
  // a plain delegation, a headless container that restarts closes its own
  // rows locally while the main daemon keeps rendering them as running
  // FOREVER: nothing over there may close a row tagged with a foreign
  // `source` (see SqliteExecutionLogRepository.sweepOrphaned's ownSource
  // scoping), so the run stays "in flight" until someone edits the DB by
  // hand. Replaying each closure as an update is what carries it across.
  sweepOrphaned(reason: string): ExecutionLog[] {
    const closed = this.primary.sweepOrphaned(reason)
    const mirrors = this.repos.slice(1)
    for (const row of closed) {
      for (const repo of mirrors) {
        try {
          repo.update(row.id, {
            finishedAt: row.finishedAt,
            outcome: row.outcome,
            errorMsg: row.errorMsg,
          })
        } catch (err) {
          log.warn({ err, op: 'sweepOrphaned', id: row.id }, 'Failed to mirror orphan closure')
        }
      }
    }
    return closed
  }

  // Fan out to whichever composed repos have async writes to drain (the
  // remote forward does; SQLite doesn't). Without this the shutdown sweep's
  // POST is still in flight when the process exits, and the next boot has
  // nothing left to forward — the row is already closed locally.
  async flush(): Promise<void> {
    await Promise.allSettled(this.repos.map((repo) => repo.flush?.()))
  }

  listDistinctSources(): string[] {
    return this.primary.listDistinctSources()
  }

  listLatestByTask(projectId: string): TaskRunSummary[] {
    return this.primary.listLatestByTask(projectId)
  }

  listLastOutputsByAgent(
    taskId: string,
  ): Array<{ agentId: string; structuredOutput: Record<string, unknown> }> {
    return this.primary.listLastOutputsByAgent(taskId)
  }
}
