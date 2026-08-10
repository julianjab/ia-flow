import { listDbStatuses } from '../db.js'
import { createLogger } from '../logger.js'
import type { ProjectSource, SourceHealth } from '../project-sources/types.js'
import { type Disposable, IssueManager } from './issue-manager.js'
import type { TransitionManager } from './transition-manager.js'
import type { BroadcastFn, IssueItem } from './types.js'

const log = createLogger('polling-issue-manager')

const DEFAULT_POLL_INTERVAL_MS = 30_000
// Health probes hit the source (usually GitHub API); cache briefly so the
// per-cycle poll gate + per-dispatch safety net don't call it back-to-back.
const HEALTH_TTL_MS = 60_000

// Generic pull-mode manager. Knows nothing about GitHub/Linear/Jira — the
// entire provider concern is behind the injected ProjectSource. Adding a new
// provider = ship a ProjectSource impl; no manager subclass, no factory.
//
// Responsibilities:
//   · Kick off source.onDaemonStart() once (crash recovery, etc.).
//   · Skip poll cycles when source.getHealth() reports a broken config
//     (missing required fields). Logs once per state transition so the log
//     doesn't spam every 30 seconds.
//   · Poll source.getItems() on an interval, filtered by the statuses the
//     project has configured with agents.
//   · Skip items already marked working (agentWorking=true) — those are being
//     processed by another loop / previous instance.
//   · Stamp every dispatched IssueItem with our projectId so the dispatcher
//     resolves the right statuses/agents.
//
// TransitionManagers are delegated to the source — see ProjectSource.
export class PollingIssueManager extends IssueManager {
  private healthCache: { at: number; health: SourceHealth } | null = null
  private lastHealthOk: boolean | null = null

  constructor(
    private readonly projectId: string,
    private readonly source: ProjectSource,
    private readonly broadcast: BroadcastFn,
    private readonly intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ) {
    super()
  }

  async getHealth(): Promise<SourceHealth> {
    if (!this.source.getHealth) return { ok: true, missing: [], warnings: [] }
    if (this.healthCache && Date.now() - this.healthCache.at < HEALTH_TTL_MS) {
      return this.healthCache.health
    }
    const health = await this.source.getHealth()
    this.healthCache = { at: Date.now(), health }
    // Log only on ok↔fail transitions so a broken project isn't spammed every
    // poll cycle, but the operator still sees it flip.
    if (this.lastHealthOk !== health.ok) {
      if (!health.ok) {
        log.warn(
          {
            projectId: this.projectId,
            missing: health.missing.map((f) => f.name),
            message: health.message,
          },
          'Source unhealthy — polling paused',
        )
      } else {
        log.info({ projectId: this.projectId }, 'Source healthy again — resuming polling')
      }
      this.lastHealthOk = health.ok
    }
    return health
  }

  start(dispatch: (item: IssueItem) => Promise<void>): Disposable {
    let stopped = false

    const configuredStatuses = (): string[] => listDbStatuses(this.projectId).map((s) => s.name)

    const poll = async () => {
      if (stopped) return
      try {
        const health = await this.getHealth()
        if (!health.ok) return // getHealth already logged the state change

        const statuses = configuredStatuses()
        if (!statuses.length) {
          // Nothing to poll — the project has no wired agents yet.
          return
        }
        for (const statusName of statuses) {
          const items = await this.source.getItems({ status: statusName, refresh: true })
          for (const raw of items) {
            const item = this.toIssueItem(raw)
            if (item.agentWorking) continue
            item.projectId = this.projectId
            dispatch(item).catch((err) =>
              log.error({ err, id: item.id, projectId: this.projectId }, 'Dispatch error'),
            )
          }
        }
      } catch (err) {
        log.error({ err, projectId: this.projectId }, 'Poll error — will retry next interval')
      }
    }

    // Crash recovery (e.g. reset stuck agent_working flags) runs once before
    // the first poll — failure here is non-fatal, poll() will retry.
    this.source
      .onDaemonStart?.()
      .then(() => poll())
      .catch((err) => log.error({ err, projectId: this.projectId }, 'onDaemonStart failed'))

    const timer = setInterval(
      () => poll().catch((err) => log.error({ err }, 'Poll failed')),
      this.intervalMs,
    )

    return {
      dispose: () => {
        stopped = true
        clearInterval(timer)
      },
    }
  }

  getTransitionManager(item: IssueItem): TransitionManager {
    if (!this.source.getTransitionManager) {
      throw new Error(
        `Source '${this.source.kind}' does not implement getTransitionManager — cannot drive transitions`,
      )
    }
    return this.source.getTransitionManager(item, this.broadcast)
  }

  private toIssueItem(raw: import('../project-sources/types.js').SourceItem): IssueItem {
    if (this.source.toIssueItem) return this.source.toIssueItem(raw)
    // Fallback (default mapping) — matches project-sources/types.defaultToIssueItem
    // but importing that here would cause a cycle in the future if we add more
    // helpers; the shape is small enough to duplicate.
    return {
      id: raw.id,
      title: raw.title,
      description: '',
      type: ((raw.meta?.type as string) ?? '').toLowerCase(),
      repos: raw.repos
        ? raw.repos
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean)
        : [],
      status: raw.status,
      agentWorking: raw.meta?.working === true,
      meta: raw.meta,
    }
  }
}
