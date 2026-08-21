import type { ExecutionLog, ExecutionLogFilters } from '@ia-flow/shared'
import type { IExecutionLogRepository } from '../../domain/ports/IExecutionLogRepository.js'
import { createLogger } from '../../logger.js'

const log = createLogger('execution-log-remote')

const REMOTE_TIMEOUT_MS = 3_000

// Write-only forward of execution log rows to another ia-flow server's
// `/api/remote-executions` — the execution-log analog of logger.ts's
// IA_FLOW_REMOTE_LOG_URL forward. Used by headless engine containers
// (agents/subscriptions-pipeline, etc.) composed with a local
// SqliteExecutionLogRepository via CompositeExecutionLogRepository so the
// "Ejecuciones" tab on the main daemon also sees their runs.
//
// Read methods are unimplemented on purpose: this repo is never the primary
// in a Composite (see CompositeExecutionLogRepository — repos[0] serves
// reads), and querying another server's execution log over HTTP for every
// list()/getById() call the UI makes isn't the problem this class solves.
export class RemoteExecutionLogRepository implements IExecutionLogRepository {
  constructor(
    private url: string,
    private token: string | undefined,
  ) {}

  private post(body: unknown): void {
    fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { 'x-ia-flow-token': this.token } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    }).catch((err) => {
      log.warn({ err, url: this.url }, 'Failed to forward execution log to remote server')
    })
  }

  insert(entry: ExecutionLog): void {
    this.post({ op: 'insert', entry })
  }

  update(id: string, patch: Partial<ExecutionLog>): void {
    this.post({ op: 'update', id, patch })
  }

  list(_filters: ExecutionLogFilters): ExecutionLog[] {
    return []
  }

  listActive(): ExecutionLog[] {
    return []
  }

  getById(_id: string): ExecutionLog | null {
    return null
  }

  sweepOrphaned(_reason: string): number {
    return 0
  }

  listDistinctSources(): string[] {
    return []
  }
}
