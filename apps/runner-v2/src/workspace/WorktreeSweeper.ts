/**
 * La limpieza de worktrees de un host (`--host`). En el runner, el worktree de una task lo borra
 * una acción de la pipeline (`cleanup_workspace`) cuando la task termina; un host no ve las
 * pipelines ni sabe cuándo termina una task, así que sin esto sus worktrees se acumulan para
 * siempre en el disco (un volumen persistente, en un pod).
 *
 * El host anota cuándo usó cada worktree por última vez (`begin`/`end`, al empezar y al terminar
 * cada corrida) en un archivo propio, y `sweep` borra los que pasaron el TTL sin uso. Conservador
 * por construcción:
 *
 * - **Sólo los que anotó.** Un worktree que el host no conoce (de otra versión, o creado a mano)
 *   no se toca.
 * - **Nunca uno en uso** (entre `begin` y `end`): una corrida larga no pierde su terreno.
 * - **Nunca con trabajo sin pushear**: en uno con branch, `isWorktreeSafeToRemove` (sin cambios
 *   y sin commits que no estén en `origin/<branch>`); en uno de carril (HEAD separado), sin
 *   cambios. Y `git worktree remove` va SIN `--force`: si quedó algo, git mismo se niega.
 * - **La branch local queda**: el remoto ya la tiene, y borrarla no libera nada que importe.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ShellRunner, WorkspaceManager } from '@ia-flow/workspace'

/** Default del TTL: tres días sin uso. Cubre un fin de semana con la task todavía en curso. */
export const DEFAULT_WORKTREE_TTL_HOURS = 72

export interface WorktreeSweeperOptions {
  shell: ShellRunner
  workspace: Pick<WorkspaceManager, 'isWorktreeSafeToRemove'>
  /** El archivo donde anota el último uso de cada worktree (JSON `{ path: epochMs }`). */
  ledgerPath: string
  ttlMs: number
  now?: () => number
  exists?: (path: string) => boolean
  log: (line: string) => void
}

export class WorktreeSweeper {
  readonly #opts: WorktreeSweeperOptions
  readonly #now: () => number
  readonly #exists: (path: string) => boolean
  readonly #lastUse: Map<string, number>
  /** Corridas en curso por worktree: dos miembros de un grupo pueden compartir uno. */
  readonly #inUse = new Map<string, number>()

  constructor(opts: WorktreeSweeperOptions) {
    this.#opts = opts
    this.#now = opts.now ?? Date.now
    this.#exists = opts.exists ?? existsSync
    this.#lastUse = new Map(Object.entries(this.#read()))
  }

  /** Una corrida empieza en `path`: queda en uso y anotada. */
  begin(path: string): void {
    this.#inUse.set(path, (this.#inUse.get(path) ?? 0) + 1)
    this.#touch(path)
  }

  /** La corrida terminó: su último uso es ahora. */
  end(path: string): void {
    const left = (this.#inUse.get(path) ?? 1) - 1
    if (left > 0) this.#inUse.set(path, left)
    else this.#inUse.delete(path)
    this.#touch(path)
  }

  /** Borra los worktrees anotados que pasaron el TTL y no están en uso. Devuelve los borrados. */
  async sweep(): Promise<string[]> {
    const cutoff = this.#now() - this.#opts.ttlMs
    const removed: string[] = []
    for (const [path, at] of [...this.#lastUse]) {
      if (at > cutoff || this.#inUse.has(path)) continue
      if (!this.#exists(path)) {
        this.#lastUse.delete(path)
        continue
      }
      // Una corrida puede empezar mientras se chequea: `git worktree remove` sin `--force` igual
      // se niega a borrar uno con cambios, y la corrida lo recrea al pedirlo.
      if (await this.#remove(path)) {
        this.#lastUse.delete(path)
        removed.push(path)
      }
    }
    this.#write()
    return removed
  }

  #touch(path: string): void {
    this.#lastUse.set(path, this.#now())
    this.#write()
  }

  async #remove(path: string): Promise<boolean> {
    const { shell, workspace, log } = this.#opts
    const repo = await this.#repoOf(path)
    if (!repo) {
      log(`[workspace] no se limpia ${path}: no es un worktree de git`)
      return false
    }
    const head = await shell.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], path)
    const branch = head.exitCode === 0 ? head.stdout.trim() : ''
    const safe =
      branch && branch !== 'HEAD'
        ? await workspace.isWorktreeSafeToRemove(path, branch).catch(() => false)
        : await this.#clean(path)
    if (!safe) {
      log(`[workspace] no se limpia ${path}: tiene trabajo sin commitear o sin pushear`)
      return false
    }
    const r = await shell.run(['git', 'worktree', 'remove', path], repo)
    if (r.exitCode !== 0) {
      log(`[workspace] no se pudo limpiar ${path}: ${(r.stderr || r.stdout).trim()}`)
      return false
    }
    log(`[workspace] worktree sin uso borrado: ${path}`)
    return true
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

  #read(): Record<string, number> {
    try {
      const parsed = JSON.parse(readFileSync(this.#opts.ledgerPath, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object') return {}
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
      )
    } catch {
      // Sin archivo (primer arranque) o roto: se empieza de cero. Lo que no está anotado no se toca.
      return {}
    }
  }

  #write(): void {
    mkdirSync(dirname(this.#opts.ledgerPath), { recursive: true })
    writeFileSync(this.#opts.ledgerPath, JSON.stringify(Object.fromEntries(this.#lastUse)))
  }
}
