/**
 * El worktree de cada corrida de un host (`--host`) vive lo que vive la corrida. El contrato con
 * el agente: si termina bien, deja todo en el remoto (commiteado y pusheado); el disco del host es
 * descartable. El siguiente agente de la cadena —en éste u otro host— arranca del remoto.
 *
 * Al terminar cada corrida (`end`), según cómo cerró el modelo (`RunEnding`):
 *
 * - **`paused`** (`wait_for_event`): queda. Al despertar, la conversación sigue en este mismo
 *   directorio (la sesión del CLI está atada a él).
 * - **cualquier otro cierre**: se borra si no tiene trabajo sin pushear. Si lo tiene, queda en
 *   disco para rescatarlo (la próxima corrida de la task lo reusa) y se dice: un `done` que deja
 *   trabajo afuera del remoto es un agente que no cumplió el contrato, y es un error.
 *
 * Nunca borra uno que otra corrida está usando (dos corridas de la misma task pueden caer en el
 * mismo host), y una corrida que pide el worktree que se está borrando espera y lo vuelve a armar.
 * `git worktree remove` va SIN `--force`: si quedó algo, git mismo se niega. La branch local
 * queda: el remoto ya la tiene.
 *
 * **El respaldo (`sweep`)**: lo que `end` deja —una pausa que nunca se retoma, trabajo sin pushear
 * de una task que no vuelve, o una corrida que el host no terminó porque se cayó— lo barre al
 * arrancar y cada tanto: todo worktree de sus clones que nadie usa y no tiene trabajo afuera del
 * remoto se borra (uno pausado también: al retomarse se vuelve a armar en el mismo path). Lo que
 * tiene trabajo sin pushear nunca se borra solo: queda en el log para rescatarlo.
 */
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RunEnding } from '@ia-flow/provider-shared'
import type { ShellRunner, WorkspaceManager } from '@ia-flow/workspace'

export interface HostWorktreesOptions {
  shell: ShellRunner
  workspace: Pick<WorkspaceManager, 'isWorktreeSafeToRemove'>
  log: { info: (line: string) => void; warn: (line: string) => void; error: (line: string) => void }
  /** Los clones del host (`<reposBase>/<owner>/<repo>`), de donde salen sus worktrees: lo que
   *  recorre `sweep`. */
  clones: () => string[]
}

/** Los clones bajo `reposBase` (`<owner>/<repo>` con su `.git`). */
export function clonesUnder(reposBase: string): () => string[] {
  const dirs = (path: string) =>
    existsSync(path)
      ? readdirSync(path, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(path, entry.name))
      : []
  return () =>
    dirs(reposBase)
      .flatMap(dirs)
      .filter((repo) => existsSync(join(repo, '.git')))
}

/** Por qué se intenta borrar: cómo cerró una corrida (`end`), o el respaldo (`sweep`). */
type RemovalCause = RunEnding | undefined | 'sweep'

/** Qué pasó con el worktree al terminar. */
export type WorktreeFate =
  | 'removed'
  | 'kept-paused'
  | 'kept-in-use'
  | 'kept-unpushed'
  | 'kept-error'

export class HostWorktrees {
  readonly #opts: HostWorktreesOptions
  /** Corridas en curso por worktree. */
  readonly #inUse = new Map<string, number>()
  /** Los que se están borrando: una corrida que empieza los espera. */
  readonly #removing = new Map<string, Promise<unknown>>()
  /** Corridas armando su worktree: mientras haya alguna, no se borra nada. */
  #preparing = 0

  constructor(opts: HostWorktreesOptions) {
    this.#opts = opts
  }

  /**
   * Una corrida empieza: arma su worktree (`prepare`) y lo deja en uso. Mientras prepara no se
   * borra nada (todavía no se sabe qué worktree va a pedir), y antes espera los borrados que ya
   * estaban en curso: si pide uno de ésos, `prepare` lo vuelve a armar.
   */
  async begin(prepare: () => Promise<string>): Promise<string> {
    this.#preparing++
    try {
      await Promise.all([...this.#removing.values()].map((removal) => removal.catch(() => {})))
      const path = await prepare()
      this.#use(path)
      return path
    } finally {
      this.#preparing--
    }
  }

  /** La corrida terminó (`ending`: cómo cerró el modelo; sin él, la sesión terminó sola). */
  async end(path: string, ending: RunEnding | undefined): Promise<WorktreeFate> {
    this.#release(path)
    if (ending === 'paused') return 'kept-paused'
    return this.#tryRemove(path, ending)
  }

  /** El respaldo: borra todo worktree de los clones que nadie usa y está limpio y pusheado.
   *  Devuelve los borrados. */
  async sweep(): Promise<string[]> {
    const removed: string[] = []
    for (const clone of this.#opts.clones()) {
      for (const path of await this.#worktreesOf(clone)) {
        if (this.#busy(path) || this.#removing.has(path)) continue
        if ((await this.#tryRemove(path, 'sweep')) === 'removed') removed.push(path)
      }
    }
    return removed
  }

  #busy(path: string): boolean {
    return this.#preparing > 0 || this.#inUse.has(path)
  }

  async #tryRemove(path: string, cause: RemovalCause): Promise<WorktreeFate> {
    if (this.#busy(path)) return 'kept-in-use'
    const removal = this.#remove(path, cause)
    this.#removing.set(path, removal)
    try {
      return await removal
    } finally {
      this.#removing.delete(path)
    }
  }

  /** Los worktrees de un clone, sin el clone mismo. */
  async #worktreesOf(clone: string): Promise<string[]> {
    const r = await this.#opts.shell.run(['git', 'worktree', 'list', '--porcelain'], clone)
    if (r.exitCode !== 0) return []
    return r.stdout
      .split('\n')
      .map((line) => line.trim().match(/^worktree (.+)$/)?.[1])
      .filter((path): path is string => path !== undefined)
      .slice(1)
  }

  #use(path: string): void {
    this.#inUse.set(path, (this.#inUse.get(path) ?? 0) + 1)
  }

  #release(path: string): void {
    const left = (this.#inUse.get(path) ?? 1) - 1
    if (left > 0) this.#inUse.set(path, left)
    else this.#inUse.delete(path)
  }

  async #remove(path: string, cause: RemovalCause): Promise<WorktreeFate> {
    const { shell, workspace, log } = this.#opts
    const repo = await this.#repoOf(path)
    if (!repo) {
      log.warn(`[workspace] ${path} no es un worktree de git: no se borra`)
      return 'kept-error'
    }
    const head = await shell.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], path)
    const branch = head.exitCode === 0 ? head.stdout.trim() : ''
    const safe =
      branch && branch !== 'HEAD'
        ? await workspace.isWorktreeSafeToRemove(path, branch).catch(() => false)
        : await this.#clean(path)
    if (!safe) {
      const where = branch && branch !== 'HEAD' ? ` (${branch})` : ''
      if (cause === 'done') {
        log.error(
          `[workspace] el agente terminó OK pero dejó trabajo sin commitear o sin pushear en ${path}${where}: queda en disco para rescatarlo`,
        )
      } else if (cause === 'sweep') {
        log.warn(`[workspace] ${path}${where} sigue con trabajo sin pushear: no se borra solo`)
      } else {
        log.warn(
          `[workspace] ${path}${where} tiene trabajo sin pushear: queda para la próxima corrida`,
        )
      }
      return 'kept-unpushed'
    }
    // Los chequeos de arriba tardan: otra corrida pudo tomarlo, o estar armando el suyo (que
    // podría ser éste), en el medio. Pasado este punto, la que empiece espera a este borrado.
    if (this.#busy(path)) return 'kept-in-use'
    const r = await shell.run(['git', 'worktree', 'remove', path], repo)
    if (r.exitCode !== 0) {
      log.warn(`[workspace] no se pudo borrar ${path}: ${(r.stderr || r.stdout).trim()}`)
      return 'kept-error'
    }
    log.info(
      `[workspace] worktree borrado ${cause === 'sweep' ? 'sin uso' : 'al terminar la corrida'}: ${path}`,
    )
    return 'removed'
  }

  /** El repo dueño del worktree: el padre de su `--git-common-dir`. */
  async #repoOf(path: string): Promise<string | undefined> {
    const r = await this.#opts.shell.run(
      ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      path,
    )
    return r.exitCode === 0 ? dirname(r.stdout.trim()) : undefined
  }

  async #clean(path: string): Promise<boolean> {
    const r = await this.#opts.shell.run(['git', 'status', '--porcelain'], path)
    return r.exitCode === 0 && r.stdout.trim() === ''
  }
}
