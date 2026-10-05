/**
 * El worktree de cada corrida de un host (`--host`) vive lo que vive la corrida. El contrato con
 * el agente: si termina bien, deja todo en el remoto (commiteado y pusheado); el disco del host es
 * descartable. El siguiente agente de la cadena —en éste u otro host— arranca del remoto.
 *
 * Al terminar cada corrida (`end`), según cómo cerró el modelo (`RunEnding`):
 *
 * - **`paused`** (`wait_for_event`): queda. Al despertar, la conversación sigue en este mismo
 *   directorio (la sesión del CLI está atada a él).
 * - **cualquier otro cierre**: se borra si no tiene trabajo afuera del remoto. Si lo tiene, queda
 *   en disco para rescatarlo (la próxima corrida de la task lo reusa) y se dice: un `done` que
 *   deja trabajo afuera del remoto es un agente que no cumplió el contrato, y es un error.
 *
 * "Afuera del remoto": cambios sin commitear, o commits que ninguna branch remota tiene — con
 * branch, `isWorktreeSafeToRemove`; con HEAD separado (un carril, o un rebase a medias), que esté
 * limpio Y que alguna branch remota contenga HEAD. Si no se puede confirmar, queda.
 *
 * Nunca borra uno que otra corrida está usando o armando (dos corridas de la misma task pueden caer
 * en el mismo host), y una corrida que empieza espera los borrados en curso. `git worktree remove`
 * va SIN `--force`. La branch local queda: el remoto ya la tiene.
 *
 * **Sólo lo que armó el host.** Cada worktree que entrega `begin` queda anotado en un registro en
 * disco (`ledgerPath`), y sólo lo anotado se borra: si un runner comparte el mismo workspace (una
 * laptop con los dos), sus worktrees no se tocan.
 *
 * **El respaldo (`sweep`)**: lo que `end` deja —una pausa que nunca se retoma, trabajo de una task
 * que no vuelve, o una corrida que el host no terminó porque se cayó— lo barre al arrancar y cada
 * tanto, con las mismas reglas (uno pausado también: al retomarse se vuelve a armar en el mismo
 * path). Lo que tiene trabajo afuera del remoto nunca se borra solo: queda en el log.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RunEnding } from '@ia-flow/provider-shared'
import type { ShellRunner, WorkspaceManager } from '@ia-flow/workspace'

export interface HostWorktreesOptions {
  shell: ShellRunner
  workspace: Pick<WorkspaceManager, 'isWorktreeSafeToRemove'>
  log: { info: (line: string) => void; warn: (line: string) => void; error: (line: string) => void }
  /** El registro de los worktrees que armó el host (JSON, una lista de paths). */
  ledgerPath: string
  exists?: (path: string) => boolean
}

/** Por qué se intenta borrar: cómo cerró una corrida (`end`), o el respaldo (`sweep`). */
type RemovalCause = RunEnding | undefined | 'sweep'

/** Qué pasó con el worktree. */
export type WorktreeFate =
  | 'removed'
  | 'kept-paused'
  | 'kept-in-use'
  | 'kept-unpushed'
  | 'kept-error'

export class HostWorktrees {
  readonly #opts: HostWorktreesOptions
  readonly #exists: (path: string) => boolean
  /** Los worktrees que armó este host (persistido: sobrevive a un reinicio). */
  readonly #owned: Set<string>
  /** Corridas en curso por worktree. */
  readonly #inUse = new Map<string, number>()
  /** Los que se están borrando: una corrida que empieza los espera. */
  readonly #removing = new Map<string, Promise<unknown>>()
  /** Corridas armando su worktree: mientras haya alguna, no se borra nada. */
  #preparing = 0

  constructor(opts: HostWorktreesOptions) {
    this.#opts = opts
    this.#exists = opts.exists ?? existsSync
    this.#owned = new Set(this.#read())
  }

  /**
   * Una corrida empieza: arma su worktree (`prepare`), lo anota como del host y lo deja en uso.
   * Mientras prepara no se borra nada (todavía no se sabe qué worktree va a pedir), y antes espera
   * los borrados en curso: si pide uno de ésos, `prepare` lo vuelve a armar.
   */
  async begin(prepare: () => Promise<string>): Promise<string> {
    this.#preparing++
    try {
      await Promise.all([...this.#removing.values()].map((removal) => removal.catch(() => {})))
      const path = await prepare()
      this.#use(path)
      if (!this.#owned.has(path)) {
        this.#owned.add(path)
        this.#write()
      }
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

  /** El respaldo: borra lo que armó el host, nadie usa y no tiene trabajo afuera del remoto.
   *  Devuelve los borrados. */
  async sweep(): Promise<string[]> {
    const removed: string[] = []
    for (const path of [...this.#owned]) {
      if (this.#busy(path) || this.#removing.has(path)) continue
      if (!this.#exists(path)) {
        this.#forget(path)
        continue
      }
      if ((await this.#tryRemove(path, 'sweep')) === 'removed') removed.push(path)
    }
    return removed
  }

  #use(path: string): void {
    this.#inUse.set(path, (this.#inUse.get(path) ?? 0) + 1)
  }

  #release(path: string): void {
    const left = (this.#inUse.get(path) ?? 1) - 1
    if (left > 0) this.#inUse.set(path, left)
    else this.#inUse.delete(path)
  }

  #busy(path: string): boolean {
    return this.#preparing > 0 || this.#inUse.has(path)
  }

  async #tryRemove(path: string, cause: RemovalCause): Promise<WorktreeFate> {
    if (!this.#owned.has(path)) return 'kept-error'
    if (this.#busy(path)) return 'kept-in-use'
    const removal = this.#remove(path, cause)
    this.#removing.set(path, removal)
    try {
      return await removal
    } finally {
      this.#removing.delete(path)
    }
  }

  async #remove(path: string, cause: RemovalCause): Promise<WorktreeFate> {
    const { shell, log } = this.#opts
    const repo = await this.#repoOf(path)
    if (!repo) {
      log.warn(`[workspace] ${path} no es un worktree de git: no se borra`)
      return 'kept-error'
    }
    const head = await shell.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], path)
    const branch = head.exitCode === 0 ? head.stdout.trim() : ''
    if (!(await this.#safe(path, branch))) {
      const where = branch && branch !== 'HEAD' ? ` (${branch})` : ''
      if (cause === 'done') {
        log.error(
          `[workspace] el agente terminó OK pero dejó trabajo afuera del remoto en ${path}${where}: queda en disco para rescatarlo`,
        )
      } else if (cause === 'sweep') {
        log.warn(
          `[workspace] ${path}${where} sigue con trabajo afuera del remoto: no se borra solo`,
        )
      } else {
        log.warn(
          `[workspace] ${path}${where} tiene trabajo afuera del remoto: queda para la próxima corrida`,
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
    this.#forget(path)
    log.info(
      `[workspace] worktree borrado ${cause === 'sweep' ? 'sin uso' : 'al terminar la corrida'}: ${path}`,
    )
    return 'removed'
  }

  /** Nada afuera del remoto. Ante cualquier duda (un git que falla), no. */
  async #safe(path: string, branch: string): Promise<boolean> {
    if (branch && branch !== 'HEAD') {
      return this.#opts.workspace.isWorktreeSafeToRemove(path, branch).catch(() => false)
    }
    // HEAD separado: un carril, o un rebase a medias. Limpio no alcanza — sus commits no están en
    // ninguna branch local que los proteja: alguna branch remota tiene que contener HEAD.
    if (!(await this.#clean(path))) return false
    const r = await this.#opts.shell.run(['git', 'branch', '-r', '--contains', 'HEAD'], path)
    return r.exitCode === 0 && r.stdout.trim() !== ''
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

  #forget(path: string): void {
    if (this.#owned.delete(path)) this.#write()
  }

  #read(): string[] {
    try {
      const parsed = JSON.parse(readFileSync(this.#opts.ledgerPath, 'utf8')) as unknown
      return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
    } catch {
      // Sin archivo (primer arranque) o roto: no se sabe qué armó, así que no se toca nada viejo.
      return []
    }
  }

  #write(): void {
    mkdirSync(dirname(this.#opts.ledgerPath), { recursive: true })
    writeFileSync(this.#opts.ledgerPath, JSON.stringify([...this.#owned]))
  }
}
