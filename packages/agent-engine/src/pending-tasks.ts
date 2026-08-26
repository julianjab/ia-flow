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
  /** True cuando la entrada NO viene del dispatch sino de reconstruirla desde
   *  almacenamiento durable (ver `PendingTaskRehydrator`). Nadie está
   *  esperando su `waitForFinish`: el proceso que lanzó el run se fue, o el
   *  watchdog soltó la entrada. Los tools de cierre la usan igual —comentan,
   *  aplican la transición, cierran la fila— pero saben que el orquestador
   *  original ya no va a hacer nada con el resultado. */
  rehydrated?: boolean
  /** Id de la fila de `execution_logs` a la que pertenece este run. Es la
   *  identidad estable del run: los tools de cierre la usan para no aplicar
   *  transiciones cuando ya hay OTRO run más nuevo abierto sobre la misma
   *  tarea. */
  executionId?: string
}

/**
 * Un run listo para cerrarse, y qué tanto se le puede aplicar.
 *
 * El cierre SIEMPRE se acepta — negarse es peor que permitir: lo más caro que
 * puede pasar por aceptar es un comentario de más; lo más caro por negarse es
 * que el agente termine su trabajo y el issue quede mudo. Lo que sí se decide
 * acá es cuánto de ese cierre se aplica.
 */
export interface ResolvedPendingTask {
  entry: PendingTask
  /** Motivo por el que este cierre NO debe aplicar la transición (aunque sí
   *  se acepta y se comenta). Se llena cuando alguien más ya se hizo cargo
   *  del estado de la tarea: el run fue cancelado a propósito, o hay otro run
   *  más nuevo en curso sobre la misma tarea y moverla ahora sería pisarlo. */
  freeze?: string
  /** El run ya había sido cerrado por un tool. El cierre es un no-op
   *  idempotente: ni comentario duplicado ni transición repetida. */
  alreadyClosed?: boolean
  /** Cierra la fila de la ejecución. Sólo viene en entradas rehidratadas: ahí
   *  el orquestador que lanzó el run ya no existe, así que nadie más va a
   *  escribir el resultado — sin esto, la fila quedaría abierta para siempre
   *  y un segundo cierre no tendría cómo saber que ya pasó. */
  finalize?: (outcome: 'success' | 'error') => void
}

/**
 * Reconstruye la entrada de un run desde almacenamiento durable cuando no
 * está en memoria.
 *
 * Existe porque el `Map` de acá abajo muere con el proceso, y la sesión del
 * agente no: un reinicio del daemon —o el watchdog soltando la entrada por
 * una lectura de liveness equivocada— dejaba al agente trabajando sin nadie
 * que le recibiera el `complete_task`. Con esto, el `Map` pasa a ser un
 * cache y la fuente de verdad es `execution_logs`.
 *
 * Devuelve `undefined` cuando no hay ninguna ejecución reconstruible para esa
 * tarea (no existe, o el proceso no tiene con qué armar el manager).
 */
export type PendingTaskRehydrator = (taskId: string) => Promise<ResolvedPendingTask | undefined>

/** Cuánto vive una entrada reconstruida en el cache. Un cierre son varios
 *  tool calls seguidos (comentario, campos, complete_task); más allá de eso
 *  conviene volver a leer el estado real. */
const REHYDRATED_TTL_MS = 30 * 60_000

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
  private rehydrator: PendingTaskRehydrator | null = null
  // Dedupe de rehidrataciones en vuelo: dos tools del mismo agente pueden
  // pedir la misma tarea a la vez y no queremos reconstruir (ni pegarle al
  // source) dos veces.
  private rehydrating = new Map<string, Promise<ResolvedPendingTask | undefined>>()
  /**
   * Entradas reconstruidas, DELIBERADAMENTE fuera de `pending`.
   *
   * `pending` significa "runs que ESTE proceso está corriendo": es lo que
   * cuentan los caps de concurrencia (capacity.ts) y lo que el apagado
   * cancela. Una entrada rehidratada no es eso — es la reconstrucción de un
   * run ajeno para poder recibirle el cierre. Meterla en `pending` le comería
   * un slot al agente y a su provider por una tarea que este proceso no está
   * corriendo.
   */
  private rehydrated = new Map<string, { entry: PendingTask; at: number }>()

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

  /** Wiring del rehidratador. Lo hace `composition/container.ts` al arrancar;
   *  sin él, `resolve` se comporta igual que `get` (que es lo que quieren los
   *  tests y cualquier proceso sin almacenamiento durable). */
  setRehydrator(fn: PendingTaskRehydrator | null): void {
    this.rehydrator = fn
  }

  /**
   * Como `get`, pero cuando la entrada no está en memoria intenta
   * reconstruirla desde almacenamiento durable.
   *
   * Es el camino que usan los tools de cierre: son los únicos que TIENEN que
   * funcionar aunque el proceso haya reiniciado a mitad del run. El resto de
   * los consumidores (conteo de capacidad, listados) siguen con `get`: les
   * interesa lo que este proceso está corriendo AHORA, no resucitar runs.
   */
  async resolve(taskId: string): Promise<ResolvedPendingTask | undefined> {
    const hit = this.pending.get(taskId)
    // Una entrada cancelada a propósito (cancel manual, o el reconciliador
    // porque alguien movió el issue a mano) se acepta pero no transiciona:
    // el estado de la tarea ya lo decidió otro.
    if (hit) return { entry: hit, freeze: hit.cancelled ? 'el run fue cancelado' : undefined }
    const held = this.rehydrated.get(taskId)
    if (held && Date.now() - held.at < REHYDRATED_TTL_MS) {
      return { entry: held.entry }
    }
    if (!this.rehydrator) return undefined
    const inFlight = this.rehydrating.get(taskId)
    if (inFlight) return inFlight
    const promise = (async () => {
      try {
        const rebuilt = await this.rehydrator?.(taskId)
        if (!rebuilt) return undefined
        // Se cachea sin crear promesa de finish: nadie está esperando este
        // run — por eso `register()` no sirve acá.
        const entry = { ...rebuilt.entry, rehydrated: true }
        this.pruneRehydrated()
        this.rehydrated.set(taskId, { entry, at: Date.now() })
        return { ...rebuilt, entry }
      } finally {
        this.rehydrating.delete(taskId)
      }
    })()
    this.rehydrating.set(taskId, promise)
    return promise
  }

  /** El cache de rehidratadas es una comodidad (varios tools del mismo cierre
   *  no re-arman la entrada), no estado que deba vivir para siempre. */
  private pruneRehydrated(): void {
    const cutoff = Date.now() - REHYDRATED_TTL_MS
    for (const [id, held] of this.rehydrated) {
      if (held.at < cutoff) this.rehydrated.delete(id)
    }
  }

  remove(
    taskId: string,
    finish?: { cancelled?: boolean; finalizedByTool?: boolean; reason?: string },
  ): void {
    const info = this.pending.get(taskId)
    this.pending.delete(taskId)
    this.rehydrated.delete(taskId)
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
export const resolvePendingTask = pendingTaskRegistry.resolve.bind(pendingTaskRegistry)
export const setPendingTaskRehydrator = pendingTaskRegistry.setRehydrator.bind(pendingTaskRegistry)
export const removePendingTask = pendingTaskRegistry.remove.bind(pendingTaskRegistry)
export const waitForFinish = pendingTaskRegistry.waitForFinish.bind(pendingTaskRegistry)
export const listPendingTasks = pendingTaskRegistry.list.bind(pendingTaskRegistry)
