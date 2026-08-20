import type {
  BroadcastFn,
  Disposable,
  IssueItem,
  PendingTaskRegistryPort,
  ProjectSource,
} from '../contract.js'
import { createLogger } from '../logger.js'
import type { CatchUpOptions } from './catch-up.js'
import { pollIntervalMs } from './env.js'
import type { ProjectFilter } from './project-filter.js'
import { SourceIssueManager } from './source-issue-manager.js'

const log = createLogger('polling-issue-manager')

// Re-exported for back-compat — moved to env.js so github-issues/source.ts's
// watch() can default to the same value without importing this class (which
// SourceDispatcher is replacing).
export { pollIntervalMs }

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
    pendingTasks: PendingTaskRegistryPort,
    intervalMs: number = pollIntervalMs(),
    opts: CatchUpOptions = {},
    hasWiredAgents?: () => boolean,
    filter?: ProjectFilter,
  ) {
    super(projectId, source, broadcast, pendingTasks, hasWiredAgents, filter)
    this.intervalMs = intervalMs
    this.crashRecovery = opts.crashRecovery ?? true
    this.initialScan = opts.initialScan ?? true
  }

  start(dispatch: (item: IssueItem) => Promise<void>): Disposable {
    let stopped = false
    const cycle = async (reason: string) => {
      if (stopped) return
      await this.runCycle(dispatch, { reason })
    }

    // Independent flags: recovery can run without an immediate cycle
    // (IA_FLOW_STARTUP_SCAN=0) and a cycle without recovery (new manager on
    // reload). Recovery failing is non-fatal — it swallows + logs. catch-up.ts.
    if (this.crashRecovery) {
      void this.onDaemonStart().then(() => {
        if (this.initialScan) void cycle('startup')
      })
    } else if (this.initialScan) {
      void cycle('startup')
    }

    const timer = setInterval(() => void cycle('interval-tick'), this.intervalMs)
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
