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
  // Last full row this process knows about, keyed by id. Lets update()
  // resend the WHOLE row (as an upsert) instead of a bare patch — if the
  // initial insert's POST was the one that got lost (the exact "network
  // blip" this class exists to survive), a later update would otherwise
  // apply `UPDATE ... WHERE id = ?` against zero rows on the remote side
  // and the run would stay invisible there forever. Bounded by process
  // lifetime; not persisted — a process restart loses the cache, and update()
  // falls back to sending the bare patch (best-effort, matches prior
  // behavior) since there is nothing to merge it into.
  private lastKnown = new Map<string, ExecutionLog>()

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
    this.lastKnown.set(entry.id, entry)
    this.post({ op: 'insert', entry })
  }

  update(id: string, patch: Partial<ExecutionLog>): void {
    const known = this.lastKnown.get(id)
    if (!known) {
      // No cached row to merge into — best-effort bare patch.
      this.post({ op: 'update', id, patch })
      return
    }
    const merged = { ...known, ...patch }
    this.lastKnown.set(id, merged)
    // Sent as an upsert (op: 'insert'), not op: 'update' — self-healing: if
    // the original insert never reached the remote server, this still
    // creates the full row instead of no-op'ing against a missing id.
    this.post({ op: 'insert', entry: merged })
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
