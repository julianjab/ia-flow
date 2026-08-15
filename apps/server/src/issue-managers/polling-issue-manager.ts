import type { IStatusRepository } from '../domain/ports/IStatusRepository.js'
import { createLogger } from '../logger.js'
import type { ProjectSource } from '../project-sources/types.js'
import type { CatchUpOptions } from './catch-up.js'
import type { Disposable } from './issue-manager.js'
import { SourceIssueManager } from './source-issue-manager.js'
import type { BroadcastFn, IssueItem } from './types.js'

const log = createLogger('polling-issue-manager')

// Configurable via IA_FLOW_POLL_INTERVAL_MS (milliseconds). Each poll cycle
// makes GraphQL calls to GitHub — bumping this is the simplest lever to reduce
// API budget consumption when rate-limited.
//
// Read lazily, never at import time: env vars stored in the DB reach
// process.env via envRepo.loadIntoProcess(), which runs after this import.
export function pollIntervalMs(): number {
  const raw = process.env.IA_FLOW_POLL_INTERVAL_MS
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : 30_000
}

// Pull mode: run a scan cycle on a fixed interval. All the cycle logic lives
// in SourceIssueManager — this class only owns the timer.
export class PollingIssueManager extends SourceIssueManager {
  private readonly intervalMs: number
  private readonly crashRecovery: boolean
  private readonly initialScan: boolean

  constructor(
    projectId: string,
    source: ProjectSource,
    broadcast: BroadcastFn,
    statusRepo: IStatusRepository,
    intervalMs: number = pollIntervalMs(),
    opts: CatchUpOptions = {},
  ) {
    super(projectId, source, broadcast, statusRepo)
    this.intervalMs = intervalMs
    this.crashRecovery = opts.crashRecovery ?? true
    this.initialScan = opts.initialScan ?? true
  }

  start(dispatch: (item: IssueItem) => Promise<void>): Disposable {
    let stopped = false
    const cycle = async () => {
      if (stopped) return
      await this.runCycle(dispatch)
    }

    // Crash recovery runs once before the first poll — failure there is
    // non-fatal (onDaemonStart swallows + logs), the cycle still starts.
    // Both are skipped on a reload of an already-running project: catch-up.ts.
    if (this.crashRecovery) void this.onDaemonStart().then(cycle)
    else if (this.initialScan) void cycle()

    const timer = setInterval(() => void cycle(), this.intervalMs)
    log.info(
      {
        projectId: this.projectId,
        intervalMs: this.intervalMs,
        crashRecovery: this.crashRecovery,
        initialScan: this.initialScan,
      },
      'Polling mode started',
    )

    return {
      dispose: () => {
        stopped = true
        clearInterval(timer)
      },
    }
  }
}
