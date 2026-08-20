// Cancels an in-flight agent run when its task's status drifted out from
// under it — the user dragged the card, or an external write moved it.
//
// This used to be a side effect of SourceIssueManager.runCycle(), free
// because that loop already had `allItems` from its own getItems() fetch on
// every cycle. Now that ProjectSource.watch() pushes only the items that
// actually changed (see contract.ts), reconciliation needs its own source of
// truth: it runs on its own timer, independent of whether watch() emits
// anything, and looks up ONLY the tasks with a `pending` agent run — never a
// full backlog scan.
//
// One instance for the whole daemon (not one per project) — see
// apps/server/src/composition/container.ts.

import type {
  Disposable,
  PendingTaskInfo,
  PendingTaskRegistryPort,
  ProjectSource,
  SourceItem,
} from '../contract.js'
import { createLogger } from '../logger.js'

const log = createLogger('divergence-reconciler')

// Read lazily (per call), never at import time — same reasoning as every
// other env-driven knob in this package (webhookDebounceMs, pollIntervalMs):
// env vars stored in the DB are pushed into process.env after module import.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** How often the reconciler re-checks every `pending` task's live status. */
export const reconcileIntervalMs = (): number => envInt('IA_FLOW_RECONCILE_INTERVAL_MS', 30_000)

export interface DivergenceReconcilerDeps {
  /** Resolve the live ProjectSource for a project id, or undefined if the
   *  project no longer exists / has no usable source (e.g. local kind). */
  resolveSource: (projectId: string) => ProjectSource | undefined
  pendingTasks: PendingTaskRegistryPort
  intervalMs?: number
  /** Surfaced instead of thrown — a reconciliation tick must never take the
   *  daemon down. */
  onError?: (err: unknown) => void
}

export class DivergenceReconciler {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: DivergenceReconcilerDeps) {}

  start(): Disposable {
    const intervalMs = this.deps.intervalMs ?? reconcileIntervalMs()
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        log.error({ err }, 'Divergence reconciliation tick failed')
        this.deps.onError?.(err)
      })
    }, intervalMs)
    return {
      dispose: () => {
        if (this.timer) clearInterval(this.timer)
        this.timer = null
      },
    }
  }

  /** Exposed for tests — runs exactly one pass without waiting for the timer. */
  async tick(): Promise<void> {
    const byProject = new Map<string, Array<[string, PendingTaskInfo]>>()
    for (const [taskId, pending] of this.deps.pendingTasks.listPendingTasks()) {
      const projectId = pending.task.projectId
      // No projectId → nothing to reconcile against (same as SourceIssueManager's
      // old `pending.task.projectId && pending.task.projectId !== this.projectId`
      // guard, just inverted: we group instead of filtering per-instance).
      if (!projectId) continue
      const bucket = byProject.get(projectId) ?? []
      bucket.push([taskId, pending])
      byProject.set(projectId, bucket)
    }
    if (!byProject.size) return

    for (const [projectId, entries] of byProject) {
      const source = this.deps.resolveSource(projectId)
      if (!source) continue
      await this.reconcileProject(source, entries)
    }
  }

  private async reconcileProject(
    source: ProjectSource,
    entries: Array<[string, PendingTaskInfo]>,
  ): Promise<void> {
    if (source.getItemById) {
      const getItemById = source.getItemById.bind(source)
      for (const [taskId, pending] of entries) {
        await this.reconcileOne(taskId, pending, () => getItemById(taskId))
      }
      return
    }
    // Source without a direct-lookup getItemById: ONE full fetch shared
    // across every pending task of this project this tick (not one fetch
    // per task) — the accepted debt is "still pays for a full list", not
    // "N full lists". See contract.ts's getItemById doc.
    let items: SourceItem[]
    try {
      items = await source.getItems({ refresh: true })
    } catch (err) {
      log.warn(
        { projectId: source.kind, err },
        'getItems() fallback failed during reconciliation — skipping this project this tick',
      )
      return
    }
    const byId = new Map(items.map((i) => [i.id, i]))
    for (const [taskId, pending] of entries) {
      await this.reconcileOne(taskId, pending, async () => byId.get(taskId) ?? null)
    }
  }

  private async reconcileOne(
    taskId: string,
    pending: PendingTaskInfo,
    lookup: () => Promise<SourceItem | null>,
  ): Promise<void> {
    let item: SourceItem | null
    try {
      item = await lookup()
    } catch (err) {
      log.warn({ taskId, err }, 'Lookup failed during reconciliation — leaving task alone')
      return
    }
    // Not found this tick (closed, deleted, transient fetch gap) — safer to
    // leave it alone than cancel on an absence. Same rule as the old loop.
    if (!item) return

    // Preserve the exact baseline SourceIssueManager used: reconciliationStatus
    // resyncs when the AGENT ITSELF moves the task mid-run (onProcess,
    // set_task_field) — comparing against initialStatus there would read the
    // agent's own legitimate move as external drift and self-cancel.
    const baseline = pending.reconciliationStatus ?? pending.initialStatus
    if (item.status.toLowerCase() === baseline.toLowerCase()) return

    log.info(
      { taskId, from: baseline, to: item.status },
      'Task moved during agent run — cancelling',
    )
    try {
      await pending.cancel?.()
    } catch (err) {
      log.warn({ taskId, err }, 'cancel handler threw — removing anyway')
    }
    this.deps.pendingTasks.removePendingTask(taskId)
  }
}
