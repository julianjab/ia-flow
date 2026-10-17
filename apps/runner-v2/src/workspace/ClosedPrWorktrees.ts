/**
 * Los worktrees de un PR que ya se cerró. Cuando el PR de una branch se mergea, lo que hay en disco
 * para esa branch —su worktree, los de carril (`<worktree>--<lane>`) y la branch local— ya no lo va
 * a usar nadie: la siguiente corrida de la task, si la hay, arranca de `main`. Sin esto quedan para
 * siempre: el guard de `isWorktreeSafeToRemove` nunca da el visto bueno después de un squash merge
 * (los commits de la branch no están en ninguna branch remota y la del PR ya se borró), así que ni
 * el fin de corrida ni el `sweep` de `HostWorktrees` los tocan.
 *
 * Lo corren el runner (sobre su workspace) y cada host (sobre el suyo): recorre los clones de
 * `<reposBase>/<owner>/<repo>`, y por cada worktree con branch le pregunta a GitHub por sus PRs.
 *
 * - **Algún PR abierto, o ninguno**: queda. Una branch sin PR es trabajo en curso.
 * - **Mergeado**: se borra con `--force`. Lo que tenía ya está en la base: un commit local que el
 *   squash no trae es una copia vieja de lo que se mergeó.
 * - **Cerrado sin merge**: se borra sólo si no tiene trabajo afuera del remoto (`isWorktreeSafeToRemove`)
 *   — un PR cerrado se puede reabrir, y GitHub sólo guarda lo que llegó a pushearse.
 *
 * Nunca lo hace antes de `graceMs` desde el cierre (lo que corre por el merge —la retrospectiva, un
 * comentario tardío— termina antes), ni si el worktree o uno de sus carriles está en uso (`busy`).
 * Ante cualquier duda (GitHub no contesta, git falla), queda: lo reintenta el próximo barrido.
 */
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { GithubClient } from '@ia-flow/github-api'
import type { ShellRunner, WorkspaceManager } from '@ia-flow/workspace'

/** Cada cuánto barre (además de al arrancar). */
export const CLOSED_PR_SWEEP_INTERVAL_MS = 10 * 60_000

/** Cuánto espera desde el cierre del PR antes de borrar. */
export const CLOSED_PR_GRACE_MS = 15 * 60_000

/** Lo que importa de un PR para decidir. */
export interface BranchPullRequest {
  number: number
  open: boolean
  merged: boolean
  /** ISO; sólo en uno cerrado. */
  closedAt?: string
}

/** Los PRs (abiertos y cerrados) cuya head es `branch` en `owner/repo`. */
export type PullRequestsOfBranch = (
  owner: string,
  repo: string,
  branch: string,
) => Promise<BranchPullRequest[]>

export interface ClosedPrWorktreesOptions {
  shell: ShellRunner
  workspace: Pick<WorkspaceManager, 'removeWorktree' | 'isWorktreeSafeToRemove'>
  /** Donde viven los clones: `<reposBase>/<owner>/<repo>`. */
  reposBase: string
  pullRequests: PullRequestsOfBranch
  /** Si una corrida está usando ese worktree. Sin él, nadie. */
  busy?: (path: string) => boolean
  log: { info: (line: string) => void; warn: (line: string) => void }
  graceMs?: number
  now?: () => number
}

interface ListedWorktree {
  path: string
  /** Sin branch: HEAD separado (un carril). */
  branch?: string
}

/** Un worktree con branch y los carriles que cuelgan de él. */
interface TaskWorktree {
  path: string
  branch: string
  lanes: string[]
}

export class ClosedPrWorktrees {
  readonly #opts: ClosedPrWorktreesOptions
  #running: Promise<string[]> | undefined

  constructor(opts: ClosedPrWorktreesOptions) {
    this.#opts = opts
  }

  /** Un barrido. Si ya hay uno en curso, devuelve ése. Devuelve los worktrees borrados. */
  sweep(): Promise<string[]> {
    this.#running ??= this.#sweep().finally(() => {
      this.#running = undefined
    })
    return this.#running
  }

  async #sweep(): Promise<string[]> {
    const removed: string[] = []
    for (const clone of this.#clones()) {
      await this.#opts.shell.run(['git', 'worktree', 'prune'], clone.path)
      for (const task of await this.#taskWorktrees(clone.path)) {
        if (await this.#release(clone, task)) removed.push(task.path)
      }
    }
    return removed
  }

  /** Los clones de `<reposBase>/<owner>/<repo>`. Sin la carpeta (nada clonado todavía), ninguno. */
  #clones(): { owner: string; repo: string; path: string }[] {
    const clones: { owner: string; repo: string; path: string }[] = []
    for (const owner of subdirs(this.#opts.reposBase)) {
      for (const repo of subdirs(join(this.#opts.reposBase, owner))) {
        clones.push({ owner, repo, path: join(this.#opts.reposBase, owner, repo) })
      }
    }
    return clones
  }

  /** Los worktrees del clone (sin el clone mismo), agrupados con sus carriles. */
  async #taskWorktrees(clone: string): Promise<TaskWorktree[]> {
    const r = await this.#opts.shell.run(['git', 'worktree', 'list', '--porcelain'], clone)
    if (r.exitCode !== 0) return []
    // El primero es siempre el clone mismo.
    const listed = parseWorktreeList(r.stdout).slice(1)
    return listed
      .filter((wt): wt is Required<ListedWorktree> => wt.branch !== undefined)
      .map((wt) => ({
        path: wt.path,
        branch: wt.branch,
        lanes: listed
          .filter((lane) => lane.branch === undefined && lane.path.startsWith(`${wt.path}--`))
          .map((lane) => lane.path),
      }))
  }

  async #release(
    clone: { owner: string; repo: string; path: string },
    task: TaskWorktree,
  ): Promise<boolean> {
    const { log } = this.#opts
    let prs: BranchPullRequest[]
    try {
      prs = await this.#opts.pullRequests(clone.owner, clone.repo, task.branch)
    } catch (err) {
      log.warn(`[workspace] no se pudo consultar el PR de ${task.branch}: ${err}`)
      return false
    }
    const pr = closedPullRequest(prs)
    if (!pr) return false
    const closedAt = Date.parse(pr.closedAt ?? '')
    const now = this.#opts.now?.() ?? Date.now()
    if (!(now - closedAt >= (this.#opts.graceMs ?? CLOSED_PR_GRACE_MS))) return false
    const busy = this.#opts.busy
    if (busy && [task.path, ...task.lanes].some((path) => busy(path))) return false
    const what = `${task.path} (${task.branch}, PR #${pr.number} ${pr.merged ? 'mergeado' : 'cerrado'})`
    if (!pr.merged) {
      const safe = await this.#opts.workspace
        .isWorktreeSafeToRemove(task.path, task.branch)
        .catch(() => false)
      if (!safe) {
        log.warn(`[workspace] ${what} tiene trabajo afuera del remoto: no se borra solo`)
        return false
      }
    }
    try {
      // Borra también los carriles y la branch local.
      await this.#opts.workspace.removeWorktree(
        basename(task.path),
        clone.path,
        task.branch,
        task.path,
      )
    } catch (err) {
      log.warn(`[workspace] no se pudo borrar ${what}: ${err}`)
      return false
    }
    log.info(`[workspace] worktree borrado: ${what}`)
    return true
  }
}

/**
 * El PR por el que se suelta la branch: ninguno si hay alguno abierto (la branch sigue viva); si
 * no, el último cerrado.
 */
export function closedPullRequest(prs: BranchPullRequest[]): BranchPullRequest | undefined {
  if (prs.length === 0 || prs.some((pr) => pr.open)) return undefined
  return [...prs].sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))[0]
}

/** `git worktree list --porcelain`: un bloque por worktree, separados por una línea vacía. */
export function parseWorktreeList(output: string): ListedWorktree[] {
  const worktrees: ListedWorktree[] = []
  for (const block of output.split(/\n\s*\n/)) {
    let path: string | undefined
    let branch: string | undefined
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
      else if (line.startsWith('branch ')) {
        branch = line
          .slice('branch '.length)
          .trim()
          .replace(/^refs\/heads\//, '')
      }
    }
    if (path) worktrees.push({ path, ...(branch ? { branch } : {}) })
  }
  return worktrees
}

/** Los PRs de una branch, por la REST de GitHub. */
export function githubPullRequests(
  github: Pick<GithubClient, 'requestJson'>,
): PullRequestsOfBranch {
  return async (owner, repo, branch) => {
    const query = new URLSearchParams({ head: `${owner}:${branch}`, state: 'all', per_page: '20' })
    const rows = await github.requestJson<
      { number: number; state: string; merged_at: string | null; closed_at: string | null }[]
    >(`/repos/${owner}/${repo}/pulls?${query}`)
    return rows.map((row) => ({
      number: row.number,
      open: row.state === 'open',
      merged: row.merged_at !== null,
      ...(row.closed_at ? { closedAt: row.closed_at } : {}),
    }))
  }
}

function subdirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}
