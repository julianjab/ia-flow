// WorkspaceManager — standalone git worktree lifecycle + agent scope resolution.
//
// Responsibilities:
//   • Own the mapping "task ↔ worktree" for a single repo (multi-repo tasks are rejected).
//   • Create / reuse / remove worktrees rooted at
//         <base>/<repo_name>/.worktrees/<taskId>/       branch: task/<taskId>
//     from `origin/main`.
//   • Handle reuse safely: autosalvage dirty state, fast-forward when possible,
//     warn (never rebase automatically) on real divergence.
//   • Compute { readPaths, writePaths } scopes given a task + agent capability.
//   • Serialize concurrent git ops per-repo (`.git/index.lock`) and per-task
//     (resolve → run → release cycle can only have one owner at a time).
//
// Design notes:
//   • ShellRunner is injected so tests can drive git output without touching disk.
//   • Class has zero dependencies on DB / providers / container — instantiable
//     in unit tests without booting the app.
//   • `.claude/**` configuration files live in-tree and are versioned in the
//     repo, so a plain `git worktree add` from `origin/main` places them inside
//     the worktree automatically. No extra copy step is needed.
//   • `IA_FLOW_CONFIG_DIR` is not hard-coded — this class never touches the
//     ia-flow config dir; the worktree base is `/tmp/ia-flow` by default and
//     is overridable via the constructor.

import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createLogger } from '../logger.js'

const log = createLogger('workspace-manager')

// ─── Shell abstraction ──────────────────────────────────────────────────

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface ShellRunner {
  /** Run `argv[0]` with `argv[1..]` in `cwd`. Never throws for non-zero exit. */
  run(args: string[], cwd: string): Promise<ShellResult>
}

// ─── Public shapes ──────────────────────────────────────────────────────

/** Minimal shape the manager needs from a task — decoupled from shared schemas. */
export interface WorkspaceTask {
  id: string
  repos: string[]
}

/** Minimal shape the manager needs from an agent definition. */
export interface WorkspaceAgentDef {
  tools?: string[]
}

export interface ResolvedScopes {
  readPaths: string[]
  writePaths: string[]
}

export interface GetOrCreateOptions {
  /** Message-only: used to tag the autosalvage commit on reuse. */
  prevRunId?: string
  /**
   * Nombre explícito de la branch git a usar. Si viene, gana sobre el default
   * `task/<taskId>`. Fuente típica: `task.branch` (linked branch de GitHub).
   */
  branch?: string
}

export interface ResolveScopesContext {
  repoBasePath: string
  /** Whether the on-disk worktree currently exists for this task. */
  worktreeExists: boolean
  /** Absolute path to the worktree (required when it exists / will be created). */
  worktreePath?: string
}

/**
 * Result of `resetWorktree`. `previousHead` is `null` when we couldn't sample
 * HEAD before the destroy step (e.g. the worktree was already gone). Both
 * hashes are surfaced verbatim to the agent so the operator can `git reflog
 * show task/<id>` to recover the previous tip.
 */
export interface ResetWorktreeResult {
  path: string
  previousHead: string | null
  newHead: string
}

// ─── Constants ──────────────────────────────────────────────────────────

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'run_command'])

export function hasWriteTools(agent: WorkspaceAgentDef): boolean {
  const tools = agent.tools ?? []
  return tools.some((t) => WRITE_TOOLS.has(t))
}

export function branchNameFor(taskId: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim()
  return `task/${taskId}`
}

export const DEFAULT_WORKTREE_BASE = '/tmp/ia-flow'

export function worktreePathFor(
  repoBasePath: string,
  taskId: string,
  base: string = DEFAULT_WORKTREE_BASE,
): string {
  return join(base, basename(repoBasePath), '.worktrees', taskId)
}

// ─── WorkspaceManager ───────────────────────────────────────────────────

export class WorkspaceManager {
  readonly #shell: ShellRunner
  readonly #base: string
  /** Hard mutex per taskId — second concurrent attempt throws. */
  readonly #taskLocks = new Map<string, Promise<unknown>>()
  /** Release handles for the taskLocks map — split so `acquireTask` /
   *  `releaseTask` can be used symmetrically from the orchestrator (which
   *  needs to hold the lock across an entire agent chain, not around a
   *  single callback). `withTaskLock` still works and is layered on top. */
  readonly #taskLockReleases = new Map<string, () => void>()
  /** repoBasePath associated with each active task, so tools invoked mid-run
   *  (e.g. `reset_worktree`) can find the source repo without threading it
   *  through the `ToolContext`. Populated on `acquireTask` / `setTaskRepoPath`
   *  and cleared on `releaseTask`. */
  readonly #taskRepoPaths = new Map<string, string>()
  /** FIFO queue per repoBasePath — serializes git ops on the same source repo. */
  readonly #repoLocks = new Map<string, Promise<unknown>>()
  /** Last-known runId per task — used to tag autosalvage commits on reuse. */
  readonly #lastRunIds = new Map<string, string>()

  constructor(shell: ShellRunner, opts: { worktreeBase?: string } = {}) {
    this.#shell = shell
    this.#base = opts.worktreeBase ?? DEFAULT_WORKTREE_BASE
  }

  // ── Public API ────────────────────────────────────────────────────────

  /** Absolute worktree path this manager will use for a task/repo pair. */
  worktreePath(taskId: string, repoBasePath: string): string {
    return worktreePathFor(repoBasePath, taskId, this.#base)
  }

  /**
   * Acquires the per-task hard mutex. Throws immediately with
   *   `task <id> ya está corriendo`
   * if the lock is already held. Optionally records the `repoBasePath` so
   * mid-run tools (e.g. `reset_worktree`) can resolve the source repo
   * without extra plumbing through the `ToolContext`.
   *
   * Must be paired with `releaseTask(taskId)` — typically in a `finally`.
   */
  acquireTask(taskId: string, repoBasePath?: string): void {
    if (this.#taskLocks.has(taskId)) {
      throw new Error(`task ${taskId} ya está corriendo`)
    }
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    this.#taskLocks.set(taskId, held)
    this.#taskLockReleases.set(taskId, release)
    if (repoBasePath) this.#taskRepoPaths.set(taskId, repoBasePath)
  }

  /** Records/updates the repoBasePath associated with an in-flight task.
   *  Safe to call even without an active lock (used by dispatch paths that
   *  set the mapping before acquiring). */
  setTaskRepoPath(taskId: string, repoBasePath: string): void {
    this.#taskRepoPaths.set(taskId, repoBasePath)
  }

  /** Releases the lock acquired by `acquireTask`. Idempotent — calling on an
   *  unlocked task is a no-op. Also clears the recorded repoBasePath. */
  releaseTask(taskId: string): void {
    const release = this.#taskLockReleases.get(taskId)
    this.#taskLockReleases.delete(taskId)
    this.#taskLocks.delete(taskId)
    this.#taskRepoPaths.delete(taskId)
    try {
      release?.()
    } catch {
      // Never propagate — this runs from the orchestrator's finally and
      // must not shadow the original error.
    }
  }

  /** Returns the repoBasePath registered for an in-flight task, or undefined. */
  taskRepoPath(taskId: string): string | undefined {
    return this.#taskRepoPaths.get(taskId)
  }

  /**
   * Serializes the full `resolveScopes → run → release` cycle on a taskId.
   * A second concurrent call for the same task fails immediately with
   *   `task <id> ya está corriendo`.
   * The agent execution itself is *not* serialized per-repo — only the wrapper.
   *
   * Sugar over `acquireTask` / `releaseTask` for callers that can express the
   * critical section as a single async callback.
   */
  async withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    this.acquireTask(taskId)
    try {
      return await fn()
    } finally {
      this.releaseTask(taskId)
    }
  }

  /** Records the runId of the last dispatch — consumed by autosalvage messages. */
  recordRunId(taskId: string, runId: string): void {
    this.#lastRunIds.set(taskId, runId)
  }

  /**
   * Cheap on-disk existence check for the worktree directory. Callers that
   * need the authoritative git-tracked answer should use `getOrCreateWorktree`
   * (which reads `git worktree list --porcelain`), but for scope resolution
   * this is enough — the worktree dir is created by us and we own its
   * lifecycle end-to-end.
   */
  worktreeExistsOnDisk(taskId: string, repoBasePath: string): boolean {
    return existsSync(this.worktreePath(taskId, repoBasePath))
  }

  /**
   * Creates or reuses the worktree for `<taskId>` under `<repoBasePath>`.
   * Always fetches `origin` first. Serialized per-repo.
   */
  async getOrCreateWorktree(
    taskId: string,
    repoBasePath: string,
    opts: GetOrCreateOptions = {},
  ): Promise<string> {
    return this.#withRepoLock(repoBasePath, () => this.#doGetOrCreate(taskId, repoBasePath, opts))
  }

  /** Removes the worktree and deletes the task branch. Serialized per-repo. */
  async removeWorktree(taskId: string, repoBasePath: string, branch?: string): Promise<void> {
    return this.#withRepoLock(repoBasePath, () => this.#doRemove(taskId, repoBasePath, branch))
  }

  /**
   * Nukes the current worktree + `task/<id>` branch and recreates a fresh
   * worktree from `origin/main`. The previous branch's tip stays in the
   * local git reflog for a manual rescue (`git reflog show task/<id>`),
   * but is no longer reachable from any ref.
   *
   * `repoBasePath` is optional when the caller previously registered the
   * task via `acquireTask(taskId, repoBasePath)` — the manager then looks it
   * up from `#taskRepoPaths`. Throws otherwise.
   *
   * Returns the new worktree path plus the pre-reset and post-reset HEAD
   * SHAs so the tool wrapper can echo the previous commit id back to the
   * agent (recoverable via `git reflog show task/<id>`). `previousHead` is
   * `null` when we couldn't sample HEAD (missing worktree, corrupted repo);
   * `newHead` falls back to `'unknown'` on the same failure mode.
   *
   * Serialized per-repo (both the remove and the recreate share the same
   * `#withRepoLock` scope so a concurrent `getOrCreate` can't interleave).
   */
  async resetWorktree(taskId: string, repoBasePath?: string): Promise<ResetWorktreeResult> {
    const base = repoBasePath ?? this.#taskRepoPaths.get(taskId)
    if (!base) {
      throw new Error(
        `resetWorktree: no repo registered for task ${taskId} (pass repoBasePath explicitly or call acquireTask first)`,
      )
    }
    return this.#withRepoLock(base, async () => {
      log.info({ taskId, repoBasePath: base }, 'reset')
      // Snapshot the doomed HEAD before we tear the worktree down. Best
      // effort: if the worktree is already missing or `rev-parse` fails,
      // fall back to `null` — the reset itself still proceeds.
      const priorWorktree = this.worktreePath(taskId, base)
      let previousHead: string | null = null
      if (existsSync(priorWorktree)) {
        const r = await this.#shell.run(['git', 'rev-parse', 'HEAD'], priorWorktree)
        if (r.exitCode === 0) previousHead = r.stdout.trim() || null
      }

      await this.#doRemove(taskId, base)
      const path = await this.#doGetOrCreate(taskId, base, {})

      const head = await this.#shell.run(['git', 'rev-parse', 'HEAD'], path)
      const newHead = head.exitCode === 0 ? head.stdout.trim() || 'unknown' : 'unknown'

      return { path, previousHead, newHead }
    })
  }

  /**
   * Pure logic (no git I/O): resolves `{ readPaths, writePaths }` from the
   * combination `worktreeExists × agent has write tools`.
   *
   * Enforces the multi-repo guard — tasks with `repos.length > 1` throw here,
   * *before* any git operation, because they signal a badly refined task.
   *
   * Scope matrix:
   *   | worktree | canWrite | readPaths        | writePaths      |
   *   |    yes   |   yes    | [worktreePath]   | [worktreePath]  |
   *   |    yes   |   no     | [worktreePath]   | []              |
   *   |    no    |   yes    | [worktreePath*]  | [worktreePath*] |  (*caller creates it)
   *   |    no    |   no     | [repoBasePath]   | []              |
   */
  resolveScopes(
    task: WorkspaceTask,
    agentDef: WorkspaceAgentDef,
    ctx: ResolveScopesContext,
  ): ResolvedScopes {
    if (task.repos.length > 1) {
      throw new Error(
        `task ${task.id} tiene ${task.repos.length} repos; WorkspaceManager solo soporta uno (task mal refinada)`,
      )
    }
    const canWrite = hasWriteTools(agentDef)
    const { worktreeExists, repoBasePath } = ctx

    if (worktreeExists) {
      const wt = ctx.worktreePath ?? this.worktreePath(task.id, repoBasePath)
      return {
        readPaths: [wt],
        writePaths: canWrite ? [wt] : [],
      }
    }
    if (canWrite) {
      // Worktree doesn't exist yet, but the agent can write → caller will
      // create it before running the agent, so surface the eventual path.
      const wt = ctx.worktreePath ?? this.worktreePath(task.id, repoBasePath)
      return { readPaths: [wt], writePaths: [wt] }
    }
    // Read-only agent, no worktree needed — expose the base repo path.
    return { readPaths: [repoBasePath], writePaths: [] }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  async #doGetOrCreate(
    taskId: string,
    repoBasePath: string,
    opts: GetOrCreateOptions,
  ): Promise<string> {
    const branch = branchNameFor(taskId, opts.branch)
    const worktree = this.worktreePath(taskId, repoBasePath)

    log.info({ taskId, repoBasePath }, 'fetch')
    await this.#gitFetch(repoBasePath)

    const exists = await this.#worktreeExists(repoBasePath, worktree)

    if (!exists) {
      log.info({ taskId, worktree, branch }, 'create')
      await this.#createWorktree(repoBasePath, worktree, branch)
      return worktree
    }

    // ── Reuse path ─────────────────────────────────────────────────────
    log.info({ taskId, worktree, branch }, 'reuse')

    if (await this.#statusDirty(worktree)) {
      const prevRunId = opts.prevRunId ?? this.#lastRunIds.get(taskId) ?? 'unknown'
      log.warn({ taskId, worktree, prevRunId }, 'autosalvage')
      await this.#commitAll(worktree, `WIP autosalvage from run ${prevRunId}`)
    }

    if (await this.#isFastForwardable(worktree)) {
      log.info({ taskId, worktree }, 'fast-forward')
      await this.#fastForward(worktree)
    } else {
      // Real divergence — do NOT rebase; leave the tree alone and warn.
      log.warn(
        { taskId, worktree, branch },
        'divergence-warning: task branch diverged from origin/main; not rebasing automatically',
      )
    }
    return worktree
  }

  async #doRemove(taskId: string, repoBasePath: string, explicitBranch?: string): Promise<void> {
    const branch = branchNameFor(taskId, explicitBranch)
    const worktree = this.worktreePath(taskId, repoBasePath)
    log.info({ taskId, worktree, branch }, 'remove')
    // Best-effort: remove worktree first (unlocks the branch), then the branch.
    // Non-zero exits are surfaced so the caller can decide (e.g. worktree missing).
    const rmWt = await this.#shell.run(
      ['git', 'worktree', 'remove', '--force', worktree],
      repoBasePath,
    )
    if (rmWt.exitCode !== 0) {
      log.warn(
        { taskId, worktree, stderr: rmWt.stderr },
        'worktree remove failed — continuing to branch delete',
      )
    }
    const rmBr = await this.#shell.run(['git', 'branch', '-D', branch], repoBasePath)
    if (rmBr.exitCode !== 0) {
      log.warn({ taskId, branch, stderr: rmBr.stderr }, 'branch delete failed')
    }
    this.#lastRunIds.delete(taskId)
  }

  /**
   * FIFO queue per repo. Each new caller waits for the current tail (success or
   * failure) to settle, then runs `fn`. When we're the last one out, we clear
   * the map entry to keep memory bounded.
   */
  async #withRepoLock<T>(repoBasePath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#repoLocks.get(repoBasePath) ?? Promise.resolve()
    const tail = prev.then(fn, fn) // ← run fn regardless of prev's outcome
    // Store a resolve-only version so subsequent waiters don't inherit rejections.
    const settled = tail.catch(() => undefined)
    this.#repoLocks.set(repoBasePath, settled)
    try {
      return await tail
    } finally {
      if (this.#repoLocks.get(repoBasePath) === settled) {
        this.#repoLocks.delete(repoBasePath)
      }
    }
  }

  // ── Git helpers (thin wrappers around #shell) ─────────────────────────

  async #gitFetch(cwd: string): Promise<void> {
    const r = await this.#shell.run(['git', 'fetch', 'origin'], cwd)
    if (r.exitCode !== 0) {
      throw new Error(`git fetch origin failed: ${r.stderr || r.stdout}`)
    }
  }

  async #worktreeExists(repoBasePath: string, path: string): Promise<boolean> {
    const r = await this.#shell.run(['git', 'worktree', 'list', '--porcelain'], repoBasePath)
    if (r.exitCode !== 0) return false
    // Porcelain output starts each block with `worktree <abs-path>`.
    return r.stdout.split('\n').some((line) => line.trim() === `worktree ${path}`)
  }

  async #branchExists(repoBasePath: string, branch: string): Promise<boolean> {
    const r = await this.#shell.run(
      ['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      repoBasePath,
    )
    return r.exitCode === 0
  }

  async #createWorktree(repoBasePath: string, worktree: string, branch: string): Promise<void> {
    // Edge case: branch survives from a previous run whose worktree was removed.
    // Reattach to the existing branch instead of failing on `-b`.
    if (await this.#branchExists(repoBasePath, branch)) {
      const r = await this.#shell.run(['git', 'worktree', 'add', worktree, branch], repoBasePath)
      if (r.exitCode !== 0) {
        throw new Error(
          `git worktree add (existing branch ${branch}) failed: ${r.stderr || r.stdout}`,
        )
      }
      return
    }
    const r = await this.#shell.run(
      ['git', 'worktree', 'add', '-b', branch, worktree, 'origin/main'],
      repoBasePath,
    )
    if (r.exitCode !== 0) {
      throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`)
    }
  }

  async #statusDirty(worktree: string): Promise<boolean> {
    const r = await this.#shell.run(['git', 'status', '--porcelain'], worktree)
    if (r.exitCode !== 0) {
      throw new Error(`git status --porcelain failed: ${r.stderr || r.stdout}`)
    }
    return r.stdout.trim().length > 0
  }

  async #commitAll(worktree: string, message: string): Promise<void> {
    const add = await this.#shell.run(['git', 'add', '-A'], worktree)
    if (add.exitCode !== 0) {
      throw new Error(`git add -A failed: ${add.stderr || add.stdout}`)
    }
    const commit = await this.#shell.run(
      ['git', 'commit', '-m', message, '--allow-empty'],
      worktree,
    )
    if (commit.exitCode !== 0) {
      throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`)
    }
  }

  /**
   * True iff HEAD is an ancestor of `origin/main` — i.e. the task branch has no
   * commits of its own and can be fast-forwarded to `origin/main` cleanly.
   */
  async #isFastForwardable(worktree: string): Promise<boolean> {
    const r = await this.#shell.run(
      ['git', 'merge-base', '--is-ancestor', 'HEAD', 'origin/main'],
      worktree,
    )
    return r.exitCode === 0
  }

  async #fastForward(worktree: string): Promise<void> {
    const r = await this.#shell.run(['git', 'merge', '--ff-only', 'origin/main'], worktree)
    if (r.exitCode !== 0) {
      throw new Error(`git merge --ff-only origin/main failed: ${r.stderr || r.stdout}`)
    }
  }
}
