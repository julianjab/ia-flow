// WorkspaceManager — standalone git worktree lifecycle + scope resolution.
//
// Responsibilities:
//   • Own the mapping "task ↔ worktree" for a single repo (multi-repo tasks are rejected).
//   • Create / reuse / remove worktrees rooted at
//         <base>/<repo_name>/.worktrees/<name>/         branch: task/<taskId>
//     from the repo's resolved base branch (`origin/HEAD`). El `<name>` es
//     legible (`task-<issue>`) y lo decide `layout.ts` — la MISMA convención
//     que usan todos los provisioners, no una privada de esta clase.
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
//     repo, so a plain `git worktree add` from the base branch places them inside
//     the worktree automatically. No extra copy step is needed.
//   • `IA_FLOW_CONFIG_DIR` is not hard-coded — this class never touches the
//     ia-flow config dir; the worktree base is `/tmp/ia-flow` by default and
//     is overridable via the constructor.

import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  DEFAULT_WORKTREE_BASE,
  FALLBACK_BASE_BRANCH,
  PROTECTED_BRANCHES,
  type WorktreeNameSource,
  branchNameFor,
  legacyWorktreePathFor,
  worktreeNameFor,
  worktreePathFor,
} from './layout.js'
import { createLogger } from './logger.js'
import type { ShellRunner } from './shell.js'

const log = createLogger('workspace-manager')

/**
 * Path canónico: sin symlinks y absoluto.
 *
 * git reporta los paths de `worktree list` YA resueltos. En macOS `/tmp` es un
 * symlink a `/private/tmp`, así que el worktree que nosotros llamamos
 * `/tmp/ia-flow/<repo>/.worktrees/task-N` git lo lista como
 * `/private/tmp/ia-flow/<repo>/.worktrees/task-N`. Comparando strings crudos el
 * mismo directorio se veía como "otro", y el run fallaba pidiendo borrar a mano
 * un worktree que era el suyo.
 *
 * `realpathSync` sólo funciona sobre lo que existe, así que se resuelve el
 * ancestro más profundo que sí está en disco y se le vuelve a pegar el resto:
 * un worktree que todavía no se creó también compara bien contra su gemelo.
 */
function canonicalPath(path: string): string {
  let head = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(head) : join(realpathSync(head), ...tail)
    } catch {
      const parent = dirname(head)
      if (parent === head) return resolve(path) // llegamos a la raíz sin suerte
      tail.unshift(basename(head))
      head = parent
    }
  }
}

/** ¿`a` y `b` nombran el MISMO directorio? Ver `canonicalPath`. */
function samePath(a: string, b: string): boolean {
  return a === b || canonicalPath(a) === canonicalPath(b)
}

// ─── Public shapes ──────────────────────────────────────────────────────

/** Minimal shape the manager needs from a task — decoupled from shared schemas. */
export interface WorkspaceTask extends WorktreeNameSource {
  repos: string[]
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

// ─── Constants ──────────────────────────────────────────────────────────

/** Minimal shape `ensureLocalClone` needs from a repo row. */
export interface CloneableRepo {
  name: string
  githubOwner?: string
  githubRepo?: string
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
  /** Task shape registrada en `acquireTask`, para que un caller que sólo
   *  tiene el id (`resetWorktree`) resuelva el mismo nombre de worktree. */
  readonly #taskSources = new Map<string, WorktreeNameSource>()
  /** FIFO queue per repoBasePath — serializes git ops on the same source repo. */
  readonly #repoLocks = new Map<string, Promise<unknown>>()
  /** Last-known runId per task — used to tag autosalvage commits on reuse. */
  readonly #lastRunIds = new Map<string, string>()
  /** Persistent base for `ensureLocalClone`. Distinct from `#base` (worktrees,
   *  ephemeral) — undefined unless the caller opts in, so tests that never
   *  clone don't need to configure it. */
  readonly #reposBase: string | undefined
  /** Token embedded in the clone/push URL for private repos. Undefined = public-only. */
  readonly #githubToken: string | undefined
  readonly #gitAuthorName: string
  readonly #gitAuthorEmail: string
  /** Cuando true (default), la limpieza borra también la branch remota si no
   *  aporta nada sobre la base. Kill-switch en el composition root. */
  readonly #deleteEmptyBranches: boolean
  /** Ver `hasLocalClone`. Inyectable para tests. */
  readonly #exists: (path: string) => boolean

  constructor(
    shell: ShellRunner,
    opts: {
      worktreeBase?: string
      reposBase?: string
      githubToken?: string
      gitAuthorName?: string
      gitAuthorEmail?: string
      deleteEmptyBranches?: boolean
      /**
       * Existencia en disco. Inyectable por la misma razón que `ShellRunner`:
       * los tests describen qué hay en el filesystem sin tocarlo.
       */
      exists?: (path: string) => boolean
    } = {},
  ) {
    this.#shell = shell
    this.#base = opts.worktreeBase ?? DEFAULT_WORKTREE_BASE
    this.#reposBase = opts.reposBase
    this.#githubToken = opts.githubToken
    this.#gitAuthorName = opts.gitAuthorName ?? 'ia-flow-bot'
    this.#gitAuthorEmail = opts.gitAuthorEmail ?? 'bot@ia-flow.local'
    this.#deleteEmptyBranches = opts.deleteEmptyBranches ?? true
    this.#exists = opts.exists ?? existsSync
  }

  /**
   * ¿Hay un clone utilizable en `path`, **en este disco**?
   *
   * Existe porque un `WorkspaceRequest` puede traer el `path` de OTRA máquina:
   * el daemon que despacha copia el que conoce (su `repos.path`) y ese valor
   * viaja al gateway remoto, donde típicamente no existe. Un provisioner que
   * lo acepta a ciegas devuelve un `cwd` fantasma y la sesión termina corriendo
   * en el directorio equivocado, en silencio.
   *
   * Mismo criterio que `#doEnsureLocalClone` (`.git` presente, sea archivo de
   * worktree o directorio de repo): un directorio vacío no es un clone.
   */
  hasLocalClone(path: string | undefined): path is string {
    return !!path && this.#exists(join(path, '.git'))
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Absolute worktree path this manager will use for a task/repo pair.
   *
   * Acepta el objeto task (no sólo el id) porque el nombre del directorio es
   * legible (`task-<issue>`) y eso necesita `issueNumber`/`title`. Un string
   * suelto se acepta para los callers que sólo tienen el id, y cae al nombre
   * derivado del id — el mismo que produce `worktreeNameFor({ id })`.
   *
   * **Compat:** si en disco ya existe el worktree con el nombre legacy (el
   * taskId crudo, como los nombraba esta clase antes de unificar la
   * convención), gana ese path. Sin esto, una task en vuelo al momento del
   * deploy dejaría su worktree —con trabajo sin commitear— huérfano y
   * empezaría uno nuevo al lado.
   */
  worktreePath(task: WorktreeNameSource | string, repoBasePath: string): string {
    const source = typeof task === 'string' ? { id: task } : task
    const legacy = legacyWorktreePathFor(repoBasePath, source.id, this.#base)
    if (existsSync(legacy)) return legacy
    return worktreePathFor(repoBasePath, worktreeNameFor(source), this.#base)
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
  acquireTask(task: WorktreeNameSource | string, repoBasePath?: string): void {
    const source = typeof task === 'string' ? { id: task } : task
    const taskId = source.id
    if (this.#taskLocks.has(taskId)) {
      throw new Error(`task ${taskId} ya está corriendo`)
    }
    // Sólo se guarda cuando el caller pasó la task entera: es lo que le
    // permite a `resetWorktree` (que sólo recibe un id, ver
    // `WorkspaceManagerPort` en @ia-flow/tools) reconstruir el MISMO nombre
    // de directorio en vez de inventar uno paralelo.
    if (typeof task !== 'string') this.#taskSources.set(taskId, task)
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
    this.#taskSources.delete(taskId)
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
  worktreeExistsOnDisk(task: WorktreeNameSource | string, repoBasePath: string): boolean {
    return existsSync(this.worktreePath(task, repoBasePath))
  }

  /**
   * Creates or reuses the worktree for `<taskId>` under `<repoBasePath>`.
   * Always fetches `origin` first. Serialized per-repo. Returns the branch
   * actually used alongside the path — WorkspaceManager is the only place
   * that decides the branch name (`branchNameFor`), so callers that want to
   * reflect it back on the `Task` (see `provisioners.ts`) don't have to
   * recompute it themselves.
   */
  async getOrCreateWorktree(
    task: WorktreeNameSource | string,
    repoBasePath: string,
    opts: GetOrCreateOptions = {},
  ): Promise<{ path: string; branch: string }> {
    const source = typeof task === 'string' ? { id: task } : task
    return this.#withRepoLock(repoBasePath, () => this.#doGetOrCreate(source, repoBasePath, opts))
  }

  /**
   * Clones `repo` into a deterministic, persistent location
   * (`<reposBase>/<githubOwner>/<githubRepo>`) if it isn't there yet, and
   * returns the local path. Idempotent — a second call against an already
   * cloned repo is a cheap existence check, no network I/O. Serialized per
   * destination so two tasks racing on the same never-cloned repo don't
   * clone twice.
   *
   * Sets the repo's local git identity (`user.name`/`user.email`) right
   * after cloning — worktrees inherit it from the shared `.git` config, so
   * this is the only place that needs to set it. Without this, the first
   * commit in a container with no global git config fails with "Author
   * identity unknown".
   */
  async ensureLocalClone(repo: CloneableRepo): Promise<string> {
    if (!this.#reposBase) {
      throw new Error(
        `ensureLocalClone: no reposBase configured (repo ${repo.name} has no local path and can't be cloned)`,
      )
    }
    if (!repo.githubOwner || !repo.githubRepo) {
      throw new Error(
        `ensureLocalClone: repo ${repo.name} has no githubOwner/githubRepo — nothing to clone from`,
      )
    }
    const dest = join(this.#reposBase, repo.githubOwner, repo.githubRepo)
    return this.#withRepoLock(dest, () => this.#doEnsureLocalClone(dest, repo))
  }

  /**
   * Consolidates the terminal-worktree auto-cleanup that the orchestrator
   * used to drive by hand: resolve the worktree path, remove it when safe,
   * warn (and leave it for manual rescue) otherwise. `isWorktreeSafeToRemove`
   * failures are treated as "not safe". No on-disk existence check — mirrors
   * the pre-extraction behaviour, which called `isWorktreeSafeToRemove`
   * unconditionally and let its own best-effort git failure handling decide.
   */
  async cleanupTerminalWorktree(
    task: WorktreeNameSource | string,
    repoBasePath: string,
    branch: string,
    /**
     * Path real del worktree, cuando el caller ya lo tiene resuelto (se lo
     * devolvió `getOrCreateWorktree`). Opcional: desde que la convención de
     * nombres es única (`layout.ts`), derivarlo de la task da el mismo
     * resultado.
     */
    explicitPath?: string,
  ): Promise<void> {
    const taskId = typeof task === 'string' ? task : task.id
    const wtPath = explicitPath ?? this.worktreePath(task, repoBasePath)
    const safe = await this.isWorktreeSafeToRemove(wtPath, branch).catch(() => false)
    if (!safe) {
      log.warn(
        { taskId, worktreePath: wtPath, branch },
        'Terminal worktree has uncommitted or unpushed work — skipping auto-remove (worktree left for manual rescue)',
      )
      return
    }
    // Decidido ANTES de borrar el worktree: el chequeo corre dentro de él
    // (necesita `origin/<branch>` y `origin/<base>` resueltos con el fetch
    // del propio worktree). Después de `git worktree remove` el path ya no
    // existe y el chequeo sería imposible.
    const remoteIsEmpty = this.#deleteEmptyBranches
      ? await this.isBranchEmptyVsBase(wtPath, branch).catch(() => false)
      : false

    log.info({ taskId, worktreePath: wtPath, branch }, 'Auto-removing clean terminal worktree')
    await this.removeWorktree(task, repoBasePath, branch, wtPath).catch((err: unknown) => {
      log.warn(
        { taskId, worktreePath: wtPath, err: err instanceof Error ? err.message : String(err) },
        'Auto-remove worktree failed — worktree stays on disk',
      )
    })

    if (remoteIsEmpty) {
      await this.deleteRemoteBranch(repoBasePath, branch)
    }
  }

  /**
   * True sólo si la branch remota `origin/<branch>` existe y **no aporta nada**
   * sobre la base (`origin/HEAD`, típicamente `origin/main`):
   *
   *   a) cero commits por delante de la base (`rev-list --count base..branch`), o
   *   b) el árbol es idéntico al de la base (`git diff --quiet base branch`) —
   *      cubre ramas con commits que no cambian nada, como el autosalvage
   *      `--allow-empty` de `#doGetOrCreate`.
   *
   * Guardas: nunca considera vacía la base misma ni `main/master/develop`, y
   * cualquier fallo de git devuelve false (no borrar ante la duda).
   *
   * **Fail-closed sobre refs rancias.** El conteo se hace contra la ref local
   * `origin/<branch>`, así que un fetch fallido (red, token vencido, rate
   * limit) la dejaría vieja y una rama que alguien pushó desde otra máquina
   * parecería vacía → la borraríamos con trabajo adentro. Por eso: el fetch
   * debe tener éxito, y el SHA que reporta `ls-remote` (que sí va al remoto)
   * debe coincidir con el de la ref local. Si no coinciden, no borramos.
   */
  async isBranchEmptyVsBase(worktreePath: string, branch: string): Promise<boolean> {
    if (PROTECTED_BRANCHES.has(branch)) return false

    const base = await this.#resolveBaseBranch(worktreePath)
    if (branch === base) return false

    // Fail-closed: sin fetch exitoso no confiamos en las refs locales.
    const fetched = await this.#gitFetch(worktreePath).then(
      () => true,
      () => false,
    )
    if (!fetched) return false

    // ¿Existe la branch en el remoto? Si no, no hay nada que borrar allá.
    const ls = await this.#shell.run(
      [
        'git',
        ...this.#githubAuthArgs(),
        'ls-remote',
        '--exit-code',
        'origin',
        `refs/heads/${branch}`,
      ],
      worktreePath,
    )
    if (ls.exitCode !== 0) return false

    // El SHA del remoto debe ser exactamente el que tenemos en `origin/<branch>`:
    // si divergen, nuestra copia está rancia y el conteo mentiría.
    const remoteSha = ls.stdout.trim().split(/\s+/)[0] ?? ''
    const localRef = await this.#shell.run(
      ['git', 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
      worktreePath,
    )
    if (localRef.exitCode !== 0) return false
    if (!remoteSha || remoteSha !== localRef.stdout.trim()) {
      log.warn(
        { worktreePath, branch, remoteSha, localSha: localRef.stdout.trim() },
        'origin/<branch> está rancio respecto al remoto — no se evalúa el borrado',
      )
      return false
    }

    const ref = `origin/${branch}`
    const ahead = await this.#shell.run(
      ['git', 'rev-list', '--count', `origin/${base}..${ref}`],
      worktreePath,
    )
    if (ahead.exitCode !== 0) return false
    if (ahead.stdout.trim() === '0') return true

    // Tiene commits propios: sólo cuenta como vacía si no cambian el árbol.
    const diff = await this.#shell.run(
      ['git', 'diff', '--quiet', `origin/${base}`, ref],
      worktreePath,
    )
    return diff.exitCode === 0
  }

  /**
   * `git push origin --delete <branch>`, best-effort — un fallo (permisos,
   * branch protegida, red) queda en el log y no rompe la limpieza.
   */
  async deleteRemoteBranch(repoBasePath: string, branch: string): Promise<void> {
    log.info({ repoBasePath, branch }, 'Deleting remote branch (no diff vs base)')
    const r = await this.#shell.run(
      ['git', ...this.#githubAuthArgs(), 'push', 'origin', '--delete', branch],
      repoBasePath,
    )
    if (r.exitCode !== 0) {
      log.warn(
        { repoBasePath, branch, stderr: r.stderr || r.stdout },
        'Remote branch delete failed — branch stays on origin',
      )
    }
  }

  /** Removes the worktree and deletes the task branch. Serialized per-repo.
   *  `explicitPath` gana sobre el path derivado del taskId (ver
   *  `cleanupTerminalWorktree`). */
  async removeWorktree(
    task: WorktreeNameSource | string,
    repoBasePath: string,
    branch?: string,
    explicitPath?: string,
  ): Promise<void> {
    const source = typeof task === 'string' ? { id: task } : task
    return this.#withRepoLock(repoBasePath, () =>
      this.#doRemove(source, repoBasePath, branch, explicitPath),
    )
  }

  /**
   * Returns true iff the worktree at `worktreePath` has no work that would
   * be lost on removal:
   *   1. No uncommitted changes (`git status --porcelain` is empty).
   *   2. No local commits ahead of `origin/<branch>`.
   *      Conservative rule: if the remote branch does not exist AND HEAD has
   *      commits beyond origin's HEAD (base), we treat that as unpushed work
   *      and refuse to remove.
   *
   * Best-effort: if any git command fails (detached HEAD, no remote, network
   * error) returns false so the caller skips removal rather than destroying
   * work silently.
   */
  async isWorktreeSafeToRemove(worktreePath: string, branch: string): Promise<boolean> {
    // 1. Uncommitted changes?
    const statusResult = await this.#shell.run(['git', 'status', '--porcelain'], worktreePath)
    if (statusResult.exitCode !== 0) return false
    if (statusResult.stdout.trim().length > 0) return false

    // 2. Local commits not pushed to origin/<branch>?
    // Check if remote branch exists (exit 0 = found, 2 = not found).
    const lsResult = await this.#shell.run(
      [
        'git',
        ...this.#githubAuthArgs(),
        'ls-remote',
        '--exit-code',
        'origin',
        `refs/heads/${branch}`,
      ],
      worktreePath,
    )
    if (lsResult.exitCode !== 0) {
      // Remote branch absent — check if HEAD is beyond origin/HEAD (base branch).
      const logResult = await this.#shell.run(
        ['git', 'log', '--oneline', 'origin/HEAD..HEAD'],
        worktreePath,
      )
      if (logResult.exitCode !== 0) return false
      return logResult.stdout.trim().length === 0
    }
    // Remote branch exists — check for commits ahead of it.
    const aheadResult = await this.#shell.run(
      ['git', 'log', '--oneline', `origin/${branch}..HEAD`],
      worktreePath,
    )
    if (aheadResult.exitCode !== 0) return false
    return aheadResult.stdout.trim().length === 0
  }

  /**
   * Nukes the current worktree + `task/<id>` branch and recreates a fresh
   * worktree from the repo's base branch. The previous branch's tip stays in the
   * local git reflog for a manual rescue (`git reflog show task/<id>`),
   * but is no longer reachable from any ref.
   *
   * `repoBasePath` is optional when the caller previously registered the
   * task via `acquireTask(taskId, repoBasePath)` — the manager then looks it
   * up from `#taskRepoPaths`. Throws otherwise.
   *
   * Serialized per-repo (both the remove and the recreate share the same
   * `#withRepoLock` scope so a concurrent `getOrCreate` can't interleave).
   */
  async resetWorktree(taskId: string, repoBasePath?: string): Promise<string> {
    const base = repoBasePath ?? this.#taskRepoPaths.get(taskId)
    if (!base) {
      throw new Error(
        `resetWorktree: no repo registered for task ${taskId} (pass repoBasePath explicitly or call acquireTask first)`,
      )
    }
    // La task registrada en `acquireTask` gana sobre el id pelado: es lo que
    // hace que el worktree recreado caiga en el MISMO directorio legible que
    // el que se acaba de borrar.
    const source = this.#taskSources.get(taskId) ?? { id: taskId }
    return this.#withRepoLock(base, async () => {
      log.info({ taskId, repoBasePath: base }, 'reset')
      await this.#doRemove(source, base)
      const { path } = await this.#doGetOrCreate(source, base, {})
      return path
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
  resolveScopes(task: WorkspaceTask, canWrite: boolean, ctx: ResolveScopesContext): ResolvedScopes {
    if (task.repos.length > 1) {
      throw new Error(
        `task ${task.id} tiene ${task.repos.length} repos; WorkspaceManager solo soporta uno (task mal refinada)`,
      )
    }
    const { worktreeExists, repoBasePath } = ctx

    if (worktreeExists) {
      const wt = ctx.worktreePath ?? this.worktreePath(task, repoBasePath)
      return {
        readPaths: [wt],
        writePaths: canWrite ? [wt] : [],
      }
    }
    if (canWrite) {
      // Worktree doesn't exist yet, but the agent can write → caller will
      // create it before running the agent, so surface the eventual path.
      const wt = ctx.worktreePath ?? this.worktreePath(task, repoBasePath)
      return { readPaths: [wt], writePaths: [wt] }
    }
    // Read-only agent, no worktree needed — expose the base repo path.
    return { readPaths: [repoBasePath], writePaths: [] }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  async #doGetOrCreate(
    task: WorktreeNameSource,
    repoBasePath: string,
    opts: GetOrCreateOptions,
  ): Promise<{ path: string; branch: string }> {
    const taskId = task.id
    const branch = branchNameFor(taskId, opts.branch)
    const worktree = this.worktreePath(task, repoBasePath)

    log.info({ taskId, repoBasePath }, 'fetch')
    await this.#gitFetch(repoBasePath)

    // `git worktree list` sigue listando worktrees cuyo directorio ya no
    // está: si alguien borró el dir a mano, `worktree add` falla por path
    // ocupado y `cd` falla por path inexistente. `prune` desregistra
    // justamente esos, así que el `list` de abajo ya responde por disco.
    // Barato e idempotente.
    await this.#shell.run(['git', 'worktree', 'prune'], repoBasePath)

    let exists = await this.#worktreeExists(repoBasePath, worktree)

    // El worktree de esta task existe pero quedó en OTRA branch: pasa cuando
    // la linked branch del issue cambia entre runs (o venía del naming
    // legacy). git no reconcilia branches en un worktree existente, así que
    // hay que reciclarlo — pero sólo si no hay trabajo en riesgo. Con cambios
    // sin commitear o commits sin pushear, se falla con un mensaje accionable
    // en vez de destruirlos.
    if (exists) {
      const current = await this.#branchOfWorktree(repoBasePath, worktree)
      if (current && current !== branch) {
        const safe = await this.isWorktreeSafeToRemove(worktree, current).catch(() => false)
        if (!safe) {
          throw new Error(
            `El worktree "${worktree}" está en la branch "${current}" y esta task ahora usa ` +
              `"${branch}", pero tiene trabajo sin commitear o sin pushear. Rescatalo y después ` +
              `removelo: git -C "${repoBasePath}" worktree remove --force "${worktree}"`,
          )
        }
        log.warn(
          { taskId, worktree, from: current, to: branch },
          'Worktree stale en otra branch y sin trabajo en riesgo — reciclando',
        )
        await this.#doRemove(task, repoBasePath, current, worktree)
        exists = false
      }
    }

    if (!exists) {
      // La branch ya está checkouteada en OTRO worktree (típicamente uno
      // legacy, nombrado con la convención anterior). git rechazaría el
      // `add`; el mensaje propio dice exactamente qué borrar.
      const owner = await this.#worktreeForBranch(repoBasePath, branch)
      if (owner && !samePath(owner, worktree)) {
        throw new Error(
          `La branch "${branch}" ya está checkouteada en el worktree "${owner}", ` +
            `distinto al que esta task usa ahora ("${worktree}"). ` +
            `Removelo para reciclarla: git -C "${repoBasePath}" worktree remove --force "${owner}"`,
        )
      }
      // Directorio ocupado pero NO registrado como worktree de ESTE repo:
      // resto de un clone anterior o de otro checkout.
      if (existsSync(worktree)) {
        throw new Error(
          `El directorio "${worktree}" existe pero no es un worktree de "${repoBasePath}". ` +
            `Revisalo y borralo para reciclarlo: rm -rf "${worktree}"`,
        )
      }
      log.info({ taskId, worktree, branch }, 'create')
      await this.#createWorktree(repoBasePath, worktree, branch)
      return { path: worktree, branch }
    }

    // ── Reuse path ─────────────────────────────────────────────────────
    log.info({ taskId, worktree, branch }, 'reuse')

    if (await this.#statusDirty(worktree)) {
      const prevRunId = opts.prevRunId ?? this.#lastRunIds.get(taskId) ?? 'unknown'
      log.warn({ taskId, worktree, prevRunId }, 'autosalvage')
      await this.#commitAll(worktree, `WIP autosalvage from run ${prevRunId}`)
    }

    // Contra la base REAL del repo (`origin/HEAD`), no contra `origin/main`
    // hardcodeado: en un repo con `master` el merge-base fallaba y toda
    // reutilización se reportaba como divergencia.
    const base = await this.#resolveBaseBranch(worktree)
    if (await this.#isFastForwardable(worktree, base)) {
      log.info({ taskId, worktree, base }, 'fast-forward')
      await this.#fastForward(worktree, base)
    } else {
      // Real divergence — do NOT rebase; leave the tree alone and warn.
      log.warn(
        { taskId, worktree, branch, base },
        `divergence-warning: task branch diverged from origin/${base}; not rebasing automatically`,
      )
    }
    return { path: worktree, branch }
  }

  async #doEnsureLocalClone(dest: string, repo: CloneableRepo): Promise<string> {
    if (existsSync(join(dest, '.git'))) {
      return dest
    }
    log.info({ repo: repo.name, dest }, 'clone')
    mkdirSync(dirname(dest), { recursive: true })
    // URL siempre limpia: embeber el token acá lo persistiría en
    // `remote.origin.url` dentro de `.git/config`, y este clone es la base de
    // los worktrees de los agentes — cualquiera con fs.read (o un `git remote
    // -v`) podría leer el PAT. La credencial va por `-c` en cada comando de
    // red, que git no escribe a disco. Ver #githubAuthArgs.
    const url = `https://github.com/${repo.githubOwner}/${repo.githubRepo}.git`
    const clone = await this.#shell.run(
      ['git', ...this.#githubAuthArgs(), 'clone', url, dest],
      dirname(dest),
    )
    if (clone.exitCode !== 0) {
      throw new Error(`git clone failed for ${repo.name}: ${clone.stderr || clone.stdout}`)
    }
    // Local (not global) identity — worktrees created off this repo inherit
    // it from the shared `.git` config, so this is the only place it's set.
    await this.#shell.run(['git', 'config', 'user.name', this.#gitAuthorName], dest)
    await this.#shell.run(['git', 'config', 'user.email', this.#gitAuthorEmail], dest)
    return dest
  }

  async #doRemove(
    task: WorktreeNameSource,
    repoBasePath: string,
    explicitBranch?: string,
    explicitPath?: string,
  ): Promise<void> {
    const taskId = task.id
    const branch = branchNameFor(taskId, explicitBranch)
    const worktree = explicitPath ?? this.worktreePath(task, repoBasePath)
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

  /**
   * Credencial de GitHub como flags `-c` en lugar de embeberla en la URL del
   * remote. `git -c` aplica la config sólo a esa invocación: no toca
   * `.git/config`, así que el token no queda en disco donde un agente con
   * fs.read pueda leerlo. Devuelve `[]` sin token (repos públicos).
   *
   * Queda el token en `argv` durante la ejecución (visible vía `ps`), que es
   * transitorio y de riesgo mucho menor que un secreto persistido; eliminarlo
   * del todo requeriría pasarlo por stdin con un credential helper.
   */
  #githubAuthArgs(): string[] {
    if (!this.#githubToken) return []
    const basic = Buffer.from(`x-access-token:${this.#githubToken}`).toString('base64')
    return ['-c', `http.extraHeader=Authorization: Basic ${basic}`]
  }

  /**
   * Base branch del repo = lo que apunta `origin/HEAD` (`origin/main`,
   * `origin/master`, …). Cae a `main` si el ref no está resuelto en el clone
   * — el resto de la clase ya asume `origin/main` al crear worktrees.
   */
  async #resolveBaseBranch(cwd: string): Promise<string> {
    const r = await this.#shell.run(
      ['git', 'symbolic-ref', '--short', '--quiet', 'refs/remotes/origin/HEAD'],
      cwd,
    )
    if (r.exitCode !== 0) return FALLBACK_BASE_BRANCH
    const short = r.stdout.trim().replace(/^origin\//, '')
    return short || FALLBACK_BASE_BRANCH
  }

  async #gitFetch(cwd: string): Promise<void> {
    const r = await this.#shell.run(['git', ...this.#githubAuthArgs(), 'fetch', 'origin'], cwd)
    if (r.exitCode !== 0) {
      throw new Error(`git fetch origin failed: ${r.stderr || r.stdout}`)
    }
  }

  async #worktreeExists(repoBasePath: string, path: string): Promise<boolean> {
    const r = await this.#shell.run(['git', 'worktree', 'list', '--porcelain'], repoBasePath)
    if (r.exitCode !== 0) return false
    // Porcelain output starts each block with `worktree <abs-path>`.
    return r.stdout.split('\n').some((line) => {
      const p = line.trim().match(/^worktree (.+)$/)?.[1]
      return !!p && samePath(p, path)
    })
  }

  async #branchExists(repoBasePath: string, branch: string): Promise<boolean> {
    const r = await this.#shell.run(
      ['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      repoBasePath,
    )
    return r.exitCode === 0
  }

  /**
   * Cadena de fallbacks para materializar el worktree. Cubre, en orden:
   *   1. la branch ya existe local (sobrevivió a un worktree removido) → reattach;
   *   2. existe sólo en el remoto → crear la local trackeando `origin/<branch>`;
   *   3. no existe en ningún lado → sacarla de `origin/<base>`;
   *   4. repo sin remoto resuelto (o `origin/<base>` sin fetch) → de la base local.
   *
   * La base es la resuelta del repo (`origin/HEAD`), no `main` hardcodeado:
   * un repo con `master` fallaba en el intento único que había antes.
   */
  async #createWorktree(repoBasePath: string, worktree: string, branch: string): Promise<void> {
    const base = await this.#resolveBaseBranch(repoBasePath)
    const attempts: string[][] = []
    if (await this.#branchExists(repoBasePath, branch)) {
      attempts.push(['worktree', 'add', worktree, branch])
    }
    attempts.push(
      ['worktree', 'add', '-b', branch, worktree, `origin/${branch}`],
      ['worktree', 'add', '-b', branch, worktree, `origin/${base}`],
      ['worktree', 'add', '-b', branch, worktree, base],
    )

    const errors: string[] = []
    for (const args of attempts) {
      const r = await this.#shell.run(['git', ...args], repoBasePath)
      if (r.exitCode === 0) return
      errors.push(`${args.join(' ')} → ${(r.stderr || r.stdout).trim()}`)
    }
    throw new Error(
      `git worktree add failed for branch "${branch}" en "${worktree}":\n${errors.join('\n')}`,
    )
  }

  /** Branch checkouteada en `worktreePath`, si el repo lo tiene registrado. */
  async #branchOfWorktree(repoBasePath: string, worktreePath: string): Promise<string | undefined> {
    const r = await this.#shell.run(['git', 'worktree', 'list', '--porcelain'], repoBasePath)
    if (r.exitCode !== 0) return undefined
    for (const block of r.stdout.split('\n\n')) {
      const p = block.match(/^worktree (.+)$/m)?.[1]?.trim()
      if (!p || !samePath(p, worktreePath)) continue
      return block.match(/^branch refs\/heads\/(.+)$/m)?.[1]?.trim()
    }
    return undefined
  }

  /** Path del worktree que tiene `branch` checkouteada, si alguno. */
  async #worktreeForBranch(repoBasePath: string, branch: string): Promise<string | undefined> {
    const r = await this.#shell.run(['git', 'worktree', 'list', '--porcelain'], repoBasePath)
    if (r.exitCode !== 0) return undefined
    for (const block of r.stdout.split('\n\n')) {
      const ref = block.match(/^branch refs\/heads\/(.+)$/m)?.[1]?.trim()
      if (ref === branch) return block.match(/^worktree (.+)$/m)?.[1]?.trim()
    }
    return undefined
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
   * True iff HEAD is an ancestor of `origin/<base>` — i.e. the task branch has
   * no commits of its own and can be fast-forwarded cleanly.
   */
  async #isFastForwardable(worktree: string, base: string): Promise<boolean> {
    const r = await this.#shell.run(
      ['git', 'merge-base', '--is-ancestor', 'HEAD', `origin/${base}`],
      worktree,
    )
    return r.exitCode === 0
  }

  async #fastForward(worktree: string, base: string): Promise<void> {
    const r = await this.#shell.run(['git', 'merge', '--ff-only', `origin/${base}`], worktree)
    if (r.exitCode !== 0) {
      throw new Error(`git merge --ff-only origin/${base} failed: ${r.stderr || r.stdout}`)
    }
  }
}
