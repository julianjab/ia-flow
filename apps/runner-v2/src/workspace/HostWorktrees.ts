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
 */
import { dirname } from 'node:path'
import type { RunEnding } from '@ia-flow/provider-shared'
import type { ShellRunner, WorkspaceManager } from '@ia-flow/workspace'

export interface HostWorktreesOptions {
  shell: ShellRunner
  workspace: Pick<WorkspaceManager, 'isWorktreeSafeToRemove'>
  log: { info: (line: string) => void; warn: (line: string) => void; error: (line: string) => void }
}

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
  /** Los que se están borrando: quien pide uno de éstos espera y lo vuelve a armar. */
  readonly #removing = new Map<string, Promise<unknown>>()

  constructor(opts: HostWorktreesOptions) {
    this.#opts = opts
  }

  /** Una corrida empieza: arma su worktree (`prepare`) y lo deja en uso. */
  async begin(prepare: () => Promise<string>): Promise<string> {
    let path = await prepare()
    this.#use(path)
    const removing = this.#removing.get(path)
    if (removing) {
      // Lo pidió mientras otra corrida lo borraba: se espera y se vuelve a armar.
      this.#release(path)
      await removing.catch(() => {})
      path = await prepare()
      this.#use(path)
    }
    return path
  }

  /** La corrida terminó (`ending`: cómo cerró el modelo; sin él, la sesión terminó sola). */
  async end(path: string, ending: RunEnding | undefined): Promise<WorktreeFate> {
    this.#release(path)
    if (ending === 'paused') return 'kept-paused'
    if (this.#inUse.has(path)) return 'kept-in-use'
    const removal = this.#remove(path, ending)
    this.#removing.set(path, removal)
    try {
      return await removal
    } finally {
      this.#removing.delete(path)
    }
  }

  #use(path: string): void {
    this.#inUse.set(path, (this.#inUse.get(path) ?? 0) + 1)
  }

  #release(path: string): void {
    const left = (this.#inUse.get(path) ?? 1) - 1
    if (left > 0) this.#inUse.set(path, left)
    else this.#inUse.delete(path)
  }

  async #remove(path: string, ending: RunEnding | undefined): Promise<WorktreeFate> {
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
      if (ending === 'done') {
        log.error(
          `[workspace] el agente terminó OK pero dejó trabajo sin commitear o sin pushear en ${path}${where}: queda en disco para rescatarlo`,
        )
      } else {
        log.warn(
          `[workspace] ${path}${where} tiene trabajo sin pushear: queda para la próxima corrida`,
        )
      }
      return 'kept-unpushed'
    }
    // Los chequeos de arriba tardan: otra corrida pudo tomarlo en el medio.
    if (this.#inUse.has(path)) return 'kept-in-use'
    const r = await shell.run(['git', 'worktree', 'remove', path], repo)
    if (r.exitCode !== 0) {
      log.warn(`[workspace] no se pudo borrar ${path}: ${(r.stderr || r.stdout).trim()}`)
      return 'kept-error'
    }
    log.info(`[workspace] worktree borrado al terminar la corrida: ${path}`)
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
