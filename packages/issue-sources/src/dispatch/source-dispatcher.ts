import type { TaskComment } from '@ia-flow/shared'
// Generic manager over a ProjectSource — replaces SourceIssueManager +
// PollingIssueManager + WebhookIssueManager. Those three decided HOW items
// arrived (a full source.getItems() fetch, on a timer or on a debounced
// webhook). Now the source itself owns that via ProjectSource.watch() (see
// contract.ts) — this class is a thin, source-agnostic consumer: it wires
// watch() to a batch handler that applies the same gates/cap/dispatch logic
// the old runCycle() did, minus divergence reconciliation (moved to
// DivergenceReconciler, which runs independently — see its module doc).
import type {
  BroadcastFn,
  DispatchOutcome,
  IssueItem,
  PendingTaskRegistryPort,
  ProjectSource,
  SourceHealth,
  SourceItem,
  TaskSource,
} from '../contract.js'
import { getRateLimit } from '../github-shared/rate-limit.js'
import { createLogger } from '../logger.js'
import type { CatchUpOptions } from './catch-up.js'
import {
  CONCURRENCY_RETRY_FLOOR_MS,
  concurrencyRetryMaxMs,
  maxConcurrentDispatches,
  maxConcurrentEvaluations,
  webhookDebounceMs,
  webhookFallbackMs,
} from './env.js'
import { type Disposable, IssueManager } from './issue-manager.js'
import { isProjectPaused } from './polling-pause.js'
import { type ProjectFilter, matchesProjectFilter } from './project-filter.js'

const log = createLogger('source-dispatcher')

// Health probes hit the source (usually GitHub API); cache briefly so a
// batch handler and the per-dispatch safety net don't call it back-to-back.
const HEALTH_TTL_MS = 60_000

export interface SourceDispatcherWatchOpts {
  intervalMs?: number
  debounceMs?: number
  fallbackMs?: number
}

export class SourceDispatcher extends IssueManager {
  private healthCache: { at: number; health: SourceHealth } | null = null
  private lastHealthOk: boolean | null = null
  private lastRateLimitedLog = false
  // Same blind-spot guard SourceIssueManager had: agentWorking has two gaps
  // (no Working field on the source; a still-in-flight mutation) that let a
  // batch re-dispatch an id already handed off. Anything already here gets
  // deferred for replay once the in-flight run releases — see tryDispatch.
  // Doubles as the evaluation-rate guard (maxConcurrentEvaluations); it is
  // NOT what the run cap counts — see `runningAgents()`.
  private readonly dispatching = new Set<string>()
  // Backlog — items a batch couldn't dispatch because the run cap or the
  // evaluation guard was saturated. Unlike the old design (which re-ran a
  // full source.getItems() scan to retry), this replays these EXACT items
  // directly once a slot frees — zero extra network cost.
  private readonly deferred = new Map<string, IssueItem>()
  private waitingForSlot = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private consecutiveCapRetries = 0
  private lastDeferredCount = Number.POSITIVE_INFINITY
  private saturated = false
  private dispatchFn: ((item: IssueItem) => Promise<DispatchOutcome | undefined>) | null = null
  private disposed = false

  constructor(
    public readonly projectId: string,
    protected readonly source: ProjectSource,
    protected readonly broadcast: BroadcastFn,
    protected readonly pendingTasks: PendingTaskRegistryPort,
    private readonly mode: 'webhook' | 'polling',
    // Cheap pre-fetch gate: skip a would-be scan (no getHealth, no
    // source.getItems()) when the project has no agent wired at all yet.
    // Defaults to always-scan so existing callers/tests don't need to pass it.
    private readonly hasWiredAgents: () => boolean = () => true,
    // Filtro general de proyecto (statusName/repoName/when), previo a
    // selectAgent — ver project-filter.ts. `undefined` = sin restricción.
    private readonly filter?: ProjectFilter,
    private readonly catchUp: CatchUpOptions = {},
    private readonly watchOpts: SourceDispatcherWatchOpts = {},
    // Cap de runs simultáneos para ESTE proyecto
    // (`project.settings.maxConcurrentDispatches`). Se lee por llamada, no se
    // congela: editar el número desde la UI aplica sin rebuildear managers.
    // `undefined` (o 0) = heredar el default global de env.
    private readonly projectRunCap: () => number | undefined = () => undefined,
  ) {
    super()
  }

  start(dispatch: (item: IssueItem) => Promise<DispatchOutcome | undefined>): Disposable {
    this.dispatchFn = dispatch
    const crashRecovery = this.catchUp.crashRecovery ?? true
    const initialScan = this.catchUp.initialScan ?? true

    // Boot catch-up: the ONE place besides watch() itself that calls
    // source.getItems() — a full scan, once, same as before. Everything
    // after boot flows through watch()'s push mechanism. Gated BEFORE the
    // fetch (not after, like processBatch can afford to be) — this is the
    // one path where skipping the gate actually avoids the network call.
    const bootScan = async () => {
      if (this.disposed || !this.shouldScan()) return
      try {
        const items = await this.source.getItems({ refresh: true })
        this.onBatch(items)
      } catch (err) {
        log.error({ err, projectId: this.projectId }, 'Boot scan failed')
      }
    }
    if (crashRecovery) {
      void this.onDaemonStart().then(() => {
        if (initialScan) void bootScan()
      })
    } else if (initialScan) {
      void bootScan()
    }

    const watchDisposable = this.source.watch((items) => this.onBatch(items), {
      projectId: this.projectId,
      mode: this.mode,
      intervalMs: this.watchOpts.intervalMs,
      debounceMs: this.watchOpts.debounceMs ?? webhookDebounceMs(),
      fallbackMs: this.watchOpts.fallbackMs ?? webhookFallbackMs(),
      onError: (err) => log.error({ err, projectId: this.projectId }, 'watch() error'),
    })

    log.info(
      { projectId: this.projectId, mode: this.mode, crashRecovery, initialScan },
      `${this.mode === 'polling' ? 'Polling' : 'Webhook'} mode started`,
    )

    return {
      dispose: () => {
        this.disposed = true
        watchDisposable.dispose()
        if (this.retryTimer) clearTimeout(this.retryTimer)
      },
    }
  }

  /** Sync entry point for ProjectSource.watch()'s onItems callback — fires
   *  the async batch handler without making the caller await it (sources
   *  already call onItems() the same fire-and-forget way). */
  private onBatch(rawItems: SourceItem[]): void {
    void this.processBatch(rawItems)
  }

  /** Same pre-checks runCycle used to gate on before touching the source at
   *  all: operator pause, GitHub-wide rate limit, and "nothing wired + no
   *  pending task of mine". Shared by the boot scan (where skipping actually
   *  avoids a source.getItems() call) and processBatch (where the fetch
   *  already happened inside the source's own watch(), but the dispatch
   *  decision still shouldn't proceed). */
  private shouldScan(): boolean {
    if (isProjectPaused(this.projectId)) return false
    const rl = getRateLimit()
    if (rl.limited) {
      if (!this.lastRateLimitedLog) {
        log.warn(
          { projectId: this.projectId, resource: rl.resource, resetAt: rl.resetAt },
          'GitHub rate limit exhausted — skipping until reset',
        )
        this.lastRateLimitedLog = true
      }
      return false
    }
    if (this.lastRateLimitedLog) {
      log.info({ projectId: this.projectId }, 'GitHub rate limit recovered — resuming')
      this.lastRateLimitedLog = false
    }
    if (!this.hasWiredAgents() && this.runningAgents() === 0) return false
    return true
  }

  /** Agents actually running for this project, read from the pending-task
   *  registry (Agent.run registers there right before calling the provider,
   *  for sync and async alike). This — not `dispatching` — is what the run
   *  cap rations: an item the gates reject never reaches Agent.run, so it
   *  never shows up here and never costs a slot. A pending without a
   *  projectId is counted as ours, matching the pre-existing behaviour of
   *  the scan gate this replaces. */
  private runningAgents(): number {
    let n = 0
    for (const [, pending] of this.pendingTasks.listPendingTasks()) {
      if (!pending.task.projectId || pending.task.projectId === this.projectId) n++
    }
    return n
  }

  /** True when nothing more should be handed off right now: either the run
   *  cap is saturated, or too many items are already being evaluated. The
   *  second is only a burst guard on source calls — it sits well above the
   *  first, so under normal load the run cap is the one that binds. */
  private atCapacity(): boolean {
    return (
      this.runningAgents() >= this.effectiveRunCap() ||
      this.dispatching.size >= maxConcurrentEvaluations()
    )
  }

  /** Cap del proyecto si define uno, si no el default global de env. Un 0
   *  cuenta como "no definido" en ambos niveles — ver env.ts y capacity.ts en
   *  @ia-flow/agent-engine para por qué 0 nunca significa "frenar todo". */
  private effectiveRunCap(): number {
    const own = this.projectRunCap()
    return own != null && own > 0 ? own : maxConcurrentDispatches()
  }

  private async processBatch(rawItems: SourceItem[]): Promise<void> {
    if (this.disposed || !this.shouldScan()) return

    // A real batch is a fresh signal — reset the concurrency-retry backoff
    // the same way every non-retry trigger() used to (see onSlotFreed's
    // sibling reset for the OTHER case: progress measured while draining
    // `deferred` with no fresh batch in between).
    this.consecutiveCapRetries = 0

    try {
      const health = await this.getHealth()
      if (!health.ok) return // getHealth already logged the state change

      for (const raw of rawItems) {
        const item = this.toIssueItem(raw)
        item.projectId = this.projectId
        this.tryDispatch(item)
      }
      this.noteCapacity()
    } catch (err) {
      log.error({ err, projectId: this.projectId }, 'Batch processing failed')
    }
  }

  /**
   * Loguea la saturación en el FLANCO, no por batch. Mientras el cap está
   * lleno, cada ciclo de scan y cada replay del backlog pasan por acá: una
   * línea por vuelta eran 12.5k líneas del daemon.log repitiendo un estado
   * que no cambió. Lo que hay que poder reconstruir es cuándo EMPEZÓ a
   * diferir y cuándo se despejó, no cuántas veces se miró en el medio.
   */
  private noteCapacity(): void {
    const saturated = this.deferred.size > 0
    if (saturated === this.saturated) return
    this.saturated = saturated
    if (!saturated) {
      log.info({ projectId: this.projectId }, 'Capacity freed — deferred backlog drained')
      return
    }
    // Both numbers, always: "deferred N, cap M" alone can't tell a
    // saturated run cap (agents genuinely busy) from a saturated
    // evaluation guard (a burst of source calls), and the two have
    // opposite fixes.
    log.info(
      {
        projectId: this.projectId,
        deferred: this.deferred.size,
        running: this.runningAgents(),
        runCap: this.effectiveRunCap(),
        evaluating: this.dispatching.size,
        evalCap: maxConcurrentEvaluations(),
      },
      'Capacity reached — deferred some dispatches',
    )
  }

  /** Applies the same per-item gates runCycle used to: project filter,
   *  agentWorking, already-dispatching/pending, then the concurrency cap.
   *  Returns false when the item got deferred. */
  private tryDispatch(item: IssueItem): boolean {
    // A fresher batch (next poll tick, a new webhook) can bring the same id
    // that's still sitting in `deferred` from an earlier cap-hit — handling
    // it here supersedes that stale entry, so retryDeferred() never
    // double-dispatches it later.
    const wasDeferred = this.deferred.delete(item.id)
    if (!matchesProjectFilter(item, this.filter)) return true
    if (item.agentWorking) return true
    if (this.dispatching.has(item.id) || this.pendingTasks.getPendingTask(item.id)) {
      // El delivery del PROPIO fin de run puede llegar antes de que el
      // dispatch se suelte: el `finally` de runAgent incluye el cleanup del
      // worktree (~segundos con providers de terminal), y el `labeled` del
      // status nuevo entra de lleno en esa ventana. Soltarlo acá era perder
      // el único delivery que traía el status fresco — el issue quedaba
      // parado hasta un nudge manual. Se difiere y el retry lo replaya
      // cuando el run en curso se suelte; retryDeferred re-chequea antes de
      // despachar, así que dos entregas del mismo id nunca corren en
      // paralelo.
      const reason = this.dispatching.has(item.id) ? 'dispatching' : 'pending-task'
      this.deferred.set(item.id, item)
      this.waitingForSlot = true
      if (!wasDeferred) {
        // En flanco (mismo criterio que noteCapacity): la primera vez que el
        // item entra al backlog por este motivo, no una línea por batch.
        log.info(
          { projectId: this.projectId, itemId: item.id, reason },
          'Item already in flight — deferred until the current run releases',
        )
      }
      // Con un dispatch en vuelo su `finally` dispara onSlotFreed solo. En
      // el caso pending-task (provider async: el dispatch ya resolvió y la
      // sesión sigue viva) no queda ningún `finally` pendiente — el retry se
      // arma acá o el backlog duerme hasta el próximo batch de la fuente.
      if (reason === 'pending-task') this.onSlotFreed()
      return false
    }
    if (this.atCapacity()) {
      this.deferred.set(item.id, item)
      this.waitingForSlot = true
      return false
    }
    this.dispatchNow(item)
    return true
  }

  private dispatchNow(item: IssueItem): void {
    const dispatch = this.dispatchFn
    if (!dispatch) {
      // Defensive only — start() sets dispatchFn before source.watch() is
      // ever called, so nothing should reach here in practice. Previously
      // (WebhookIssueManager) a missing dispatch fn silently no-opped every
      // batch with zero log output; that's the bug this replaces.
      log.error(
        { projectId: this.projectId, itemId: item.id },
        'SourceDispatcher.start() was never called — dropping item',
      )
      return
    }
    this.dispatching.add(item.id)
    dispatch(item)
      .then((outcome) => {
        // El dispatcher tenía trabajo para este item pero no capacidad (cap
        // del agente, o todos sus providers candidatos saturados). Devolverlo
        // al backlog es lo que hace que se reintente al liberarse un slot, en
        // vez de esperar al próximo batch de la fuente. La entrada NO se
        // vuelve a poner si un batch más fresco ya trajo el mismo id
        // (tryDispatch lo borra de `deferred` al entrar).
        if (outcome === 'deferred') {
          this.deferred.set(item.id, item)
          this.waitingForSlot = true
        }
      })
      .catch((err) => log.error({ err, id: item.id, projectId: this.projectId }, 'Dispatch error'))
      .finally(() => {
        this.dispatching.delete(item.id)
        this.onSlotFreed()
      })
  }

  /** Event-driven concurrency-cap retry — fires when a dispatch finishes and
   *  frees a slot, but only when something is actually waiting on it.
   *  Debounced by CONCURRENCY_RETRY_FLOOR_MS (exponential backoff) so slots
   *  freeing almost instantly don't tight-loop. */
  private onSlotFreed(): void {
    if (!this.waitingForSlot || this.retryTimer) return
    this.waitingForSlot = false
    const delayMs = Math.min(
      CONCURRENCY_RETRY_FLOOR_MS * 2 ** this.consecutiveCapRetries,
      concurrencyRetryMaxMs(),
    )
    this.consecutiveCapRetries++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retryDeferred()
    }, delayMs)
  }

  /** Replays exactly the items deferred past capacity — no source call. */
  private retryDeferred(): void {
    if (this.disposed || !this.deferred.size || !this.shouldScan()) return
    // Progress (backlog shrinking since the last retry) resets the backoff —
    // same semantics as the old skippedForConcurrency comparison.
    if (this.deferred.size < this.lastDeferredCount) this.consecutiveCapRetries = 0
    this.lastDeferredCount = this.deferred.size

    for (const [id, item] of [...this.deferred.entries()]) {
      if (this.atCapacity()) break
      // Still in flight when the retry fires (the run's cleanup can outlast
      // the backoff floor) — keep the entry for the next retry instead of
      // dropping it: this backlog is the ONLY holder of that delivery, and
      // the in-flight run won't re-deliver it when it releases.
      if (this.dispatching.has(id) || this.pendingTasks.getPendingTask(id)) continue
      this.deferred.delete(id)
      this.dispatchNow(item)
    }
    if (this.deferred.size > 0) {
      this.waitingForSlot = true
      // Re-armar el timer acá no es redundante: el otro disparador
      // (`onSlotFreed`, en el `finally` de dispatchNow) sólo corre cuando un
      // DISPATCH termina, y con providers async el dispatch resuelve apenas
      // se spawnea la sesión mientras el agente sigue contando en
      // `runningAgents()`. Si el cap se llenó con sesiones async y no queda
      // ningún dispatch en vuelo, nadie volvería a mirar el backlog hasta el
      // próximo batch de la fuente — justo lo que este backlog existe para
      // evitar. El backoff exponencial de onSlotFreed acota el costo.
      this.onSlotFreed()
    }
    // El flanco de bajada sólo puede verse acá: mientras el backlog se drena
    // sin batches nuevos de la fuente, `processBatch` no vuelve a correr.
    this.noteCapacity()
  }

  async getHealth(): Promise<SourceHealth> {
    if (!this.source.getHealth) return { ok: true, missing: [], warnings: [] }
    if (this.healthCache && Date.now() - this.healthCache.at < HEALTH_TTL_MS) {
      return this.healthCache.health
    }
    const health = await this.source.getHealth()
    this.healthCache = { at: Date.now(), health }
    if (this.lastHealthOk !== health.ok) {
      if (!health.ok) {
        log.warn(
          {
            projectId: this.projectId,
            missing: health.missing.map((f) => f.name),
            message: health.message,
          },
          'Source unhealthy — dispatch paused',
        )
      } else {
        log.info({ projectId: this.projectId }, 'Source healthy again — resuming dispatch')
      }
      this.lastHealthOk = health.ok
    }
    return health
  }

  /** Crash recovery (e.g. reset stuck working flags). Non-fatal on failure. */
  private async onDaemonStart(): Promise<void> {
    try {
      await this.source.onDaemonStart?.()
    } catch (err) {
      log.error({ err, projectId: this.projectId }, 'onDaemonStart failed')
    }
  }

  getTransitionManager(item: IssueItem): TaskSource {
    if (!this.source.getTransitionManager) {
      throw new Error(
        `Source '${this.source.kind}' does not implement getTransitionManager — cannot drive transitions`,
      )
    }
    return this.source.getTransitionManager(item, this.broadcast)
  }

  async getBlockers(
    item: IssueItem,
  ): Promise<Array<{ id: string; ref?: string; title?: string; status?: string; url?: string }>> {
    if (!this.source.getBlockers) return []
    return this.source.getBlockers(item)
  }

  async loadComments(item: IssueItem): Promise<TaskComment[]> {
    if (!this.source.loadComments) return []
    return this.source.loadComments(item)
  }

  async markCommentsUsed(comments: Array<{ id: string; body: string }>): Promise<void> {
    await this.source.markCommentsUsed?.(comments)
  }

  private toIssueItem(raw: SourceItem): IssueItem {
    if (this.source.toIssueItem) return this.source.toIssueItem(raw)
    // Fallback (default mapping) — matches contract.defaultToIssueItem but
    // duplicated here rather than imported, same reasoning SourceIssueManager
    // had: the shape is small enough that a future cycle risk isn't worth it.
    const fromCustomField = raw.repos
      ? raw.repos
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : []
    const hostRepo = raw.meta?.repoName as string | undefined
    const repos = fromCustomField.length > 0 ? fromCustomField : hostRepo ? [hostRepo] : []
    return {
      id: raw.id,
      title: raw.title,
      description: '',
      type: ((raw.meta?.type as string) ?? '').toLowerCase(),
      repos,
      status: raw.status,
      agentWorking: raw.meta?.working === true,
      issueNumber: raw.meta?.issueNumber as number | undefined,
      issueUrl: raw.meta?.issueUrl as string | undefined,
      labels: (raw.meta?.labels as string[] | undefined) ?? [],
      assignees: (raw.meta?.assignees as string[] | undefined) ?? [],
      fields: (raw.meta?.fields as Record<string, string> | undefined) ?? {},
      meta: raw.meta,
    }
  }
}
