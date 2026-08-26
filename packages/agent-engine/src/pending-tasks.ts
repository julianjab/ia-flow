import type { TaskSource } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'

type BroadcastFn = (msg: object) => void

export interface PendingTask {
  task: Task
  manager: TaskSource
  onFinish?: string
  onError?: string
  broadcast: BroadcastFn
  /** Status of the task when the agent was dispatched. FROZEN for the whole
   *  run — never mutated after `register()`. `complete_task`/`fail_task`
   *  (packages/tools/src/task/task.ts) compare it against the status at
   *  finish time to detect whether the prompt itself already moved the task
   *  (`statusChangedByPrompt`), so they can skip re-applying the default
   *  onFinish/onError transition on top of a status the agent already set
   *  deliberately. Do NOT repurpose this for reconciliation — see
   *  `reconciliationStatus` below, which exists specifically because this
   *  one must stay put. */
  initialStatus: string
  /** Reconciliation baseline for SourceIssueManager's divergence-cancel
   *  loop (packages/issue-sources/src/dispatch/source-issue-manager.ts) —
   *  starts equal to `initialStatus` but, unlike it, gets resynced by
   *  `set_task_field` whenever the AGENT itself moves the task's status
   *  mid-run (e.g. lh116-ci-watcher forcing Status as an onError fallback).
   *  Without that resync, the next scan cycle would see the agent's own
   *  legitimate move as external drift and cancel the run out from under
   *  itself. Falls back to `initialStatus` when unset (older callers that
   *  construct a `PendingTask` by hand, e.g. tests, don't need to know
   *  about this field). */
  reconciliationStatus?: string
  /** Set by the orchestrator once the provider run is in flight. Kills the
   *  underlying session/request and clears working state. Idempotent. */
  cancel?: () => Promise<void>
  /** Terminates only the underlying provider session (e.g. tmux kill-session)
   *  without touching the pending-task state or transitions. Invoked from
   *  complete_task / fail_task so the pane closes when the agent signals it
   *  is done, instead of lingering until the operator kills it. */
  killSession?: () => Promise<void>
  /** Stops the liveness watchdog started by the orchestrator for async
   *  provider sessions. Set alongside `killSession`. Invoked from
   *  `removePendingTask` so a normally-finished run doesn't keep polling
   *  a session we just tore down. */
  unwatchSession?: () => void
  /** True once `cancel` has been invoked. Downstream tool callbacks (e.g.
   *  complete_task arriving from a killed tmux pane) check this to skip
   *  re-applying transitions on top of the user's new state. */
  cancelled?: boolean
  /** Correlation context for logs emitted after the provider returns —
   *  in particular by complete_task / fail_task tool handlers that fire
   *  from the spawned async session. Mirrors the anthropic-api logCtx. */
  runId?: string
  agentId?: string
  /** Provider que corre este agente, ya resuelto por `resolveProvider`.
   *  Lo consume el cap por provider (capacity.ts → countRunningByProvider):
   *  es el único lugar donde se sabe cuántos runs tiene en vuelo un provider
   *  a través de todos los proyectos y agentes. */
  providerId?: string
  /** Human-facing agent label used as the header of the auto-generated
   *  lifecycle comment (complete_task / fail_task). Falls back to `agentId`
   *  when not provided. */
  agentName?: string
  projectId?: string
}

export interface FinishResult {
  /** Snapshot of the task at the moment the pending entry was removed —
   *  reflects mutations applied by complete_task / fail_task tools. */
  task: Task
  /** True if the run was cancelled (either by the polling divergence gate
   *  or by any caller passing `{ cancelled: true }`). */
  cancelled: boolean
  /** True if a tool (complete_task / fail_task) removed the entry, meaning
   *  transitions were already applied and the orchestrator must not run its
   *  default onFinish/onError logic on top. */
  finalizedByTool: boolean
  /** Por qué se cortó, en texto para humanos. Termina en el `error_msg` de
   *  `execution_logs`: sin esto, un cancel del watchdog y uno manual quedan
   *  idénticos en la tabla y el próximo incidente hay que reconstruirlo a
   *  fuerza de logs. */
  reason?: string
}

/**
 * Registry of agent runs currently in flight. A proper class (not a bag of
 * module-level Maps) so a caller CAN construct an isolated instance — but
 * the default export below is a single shared instance + bound top-level
 * functions, preserving the exact call sites every consumer (AgentOrchestrator,
 * apps/server's tools/task.ts lifecycle tools, the daemon's pending-task
 * listing route) already used before this class existed. Every consumer
 * imports these bound functions directly from this package.
 */
export class PendingTaskRegistry {
  private pending = new Map<string, PendingTask>()
  // Async-agent finish plumbing. When the orchestrator hands control to an
  // async provider (tmux/iterm), provider.run returns immediately with only
  // the session started. The chain-runner needs to block until the agent
  // actually signals completion via complete_task / fail_task / cancel, or the
  // next iteration would run in parallel on the same task.
  private finishResolvers = new Map<string, (r: FinishResult) => void>()
  private finishPromises = new Map<string, Promise<FinishResult>>()

  register(taskId: string, info: PendingTask): void {
    this.pending.set(taskId, info)
    let resolve!: (r: FinishResult) => void
    const promise = new Promise<FinishResult>((r) => {
      resolve = r
    })
    this.finishResolvers.set(taskId, resolve)
    this.finishPromises.set(taskId, promise)
  }

  get(taskId: string): PendingTask | undefined {
    return this.pending.get(taskId)
  }

  remove(
    taskId: string,
    finish?: { cancelled?: boolean; finalizedByTool?: boolean; reason?: string },
  ): void {
    const info = this.pending.get(taskId)
    this.pending.delete(taskId)
    // Stop the liveness watchdog before we resolve the waiter: otherwise a
    // late `isAlive` tick could fire onDead against a session we're about to
    // tear down and re-cancel an already-finalized run.
    try {
      info?.unwatchSession?.()
    } catch {}
    const resolver = this.finishResolvers.get(taskId)
    this.finishResolvers.delete(taskId)
    this.finishPromises.delete(taskId)
    if (resolver && info) {
      resolver({
        task: info.task,
        cancelled: finish?.cancelled ?? info.cancelled === true,
        finalizedByTool: finish?.finalizedByTool ?? false,
        reason: finish?.reason,
      })
    }
  }

  /** Await the completion of a pending agent run. Returns the pre-registered
   *  promise (created by `register`) so callers that grab it right after
   *  registration will still receive the result even if the entry is removed
   *  before they await. Returns null if there is no pending entry registered
   *  under `taskId` (e.g. the run finished synchronously before the caller
   *  asked). */
  waitForFinish(taskId: string): Promise<FinishResult> | null {
    return this.finishPromises.get(taskId) ?? null
  }

  list(): Array<[string, PendingTask]> {
    return [...this.pending.entries()]
  }
}

// ─── Default shared instance ────────────────────────────────────────────
// AgentOrchestrator falls back to this when no registry is injected (see its
// constructor), and it's what apps/server's shim binds to — so every
// consumer observes the same in-flight state unless a caller deliberately
// constructs its own `PendingTaskRegistry` for isolation (e.g. tests).
export const pendingTaskRegistry = new PendingTaskRegistry()

export const registerPendingTask = pendingTaskRegistry.register.bind(pendingTaskRegistry)
export const getPendingTask = pendingTaskRegistry.get.bind(pendingTaskRegistry)
export const removePendingTask = pendingTaskRegistry.remove.bind(pendingTaskRegistry)
export const waitForFinish = pendingTaskRegistry.waitForFinish.bind(pendingTaskRegistry)
export const listPendingTasks = pendingTaskRegistry.list.bind(pendingTaskRegistry)
