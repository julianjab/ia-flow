/**
 * Las dependencias de Node de un worktree (`node_modules`), sin instalar.
 *
 * Un worktree nuevo —el de una task, o el de un carril `task-N--e2e-visual-qa`— nace sin
 * `node_modules` (está ignorado por git), y el agente gastaba su sesión en `yarn install`: contra
 * un registry privado y lento terminaba en `ESOCKETTIMEDOUT` y la corrida se iba sin probar nada
 * (lh-seller-v2-frontend#4381, #4392). Acá se REUSA lo que ya está en disco, nunca se baja nada:
 *
 * - **De dónde**: la semilla del repo para ese lockfile (`<repo>/.git/ia-flow-deps/<hash>`), o el
 *   `node_modules` de otro worktree del MISMO repo con el MISMO lockfile (sha256 del archivo). Con
 *   el lockfile igual, el árbol instalado es el mismo.
 * - **Cómo**: una COPIA propia, no un symlink ni hardlinks. Un symlink compartiría `.vite`,
 *   `.cache` y lo que vitest/nuxt regeneran adentro entre corridas paralelas (el reviewer y el e2e
 *   van a la vez), y quedaría colgando cuando se borra el otro worktree. Un hardlink comparte el
 *   inodo: un `yarn add` que reescribe un archivo en su lugar (`copyFile` trunca el destino)
 *   rompería el otro worktree y la semilla. La copia usa clone copy-on-write donde el disco lo
 *   tiene (`cp -c` en APFS, `--reflink=auto` en Linux) y si no, copia común: local, sin red.
 * - **La semilla**: al borrar un worktree, su `node_modules` se MUEVE (`rename`, instantáneo) a
 *   `.git/ia-flow-deps/<hash>` si todavía no hay una para ese lockfile. Así sobrevive a un host que
 *   borra el worktree de cada corrida. Vive dentro de `.git` (nunca aparece en un `git status`) y
 *   se va con el clone; quedan las {@link MAX_SEEDS} más nuevas.
 *
 * Nada de esto tira: un reuso que falla deja el worktree como estaba y lo dice
 * ({@link DependencyStatus}), para que el agente no reintente instalaciones largas a ciegas.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  utimesSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ShellRunner } from './shell.js'

/** Los lockfiles que identifican un repo de Node, en orden de preferencia. */
export const LOCKFILES = [
  'yarn.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
] as const

/** Cuántas semillas (lockfiles distintos) quedan por repo. Cada una pesa lo que un node_modules. */
export const MAX_SEEDS = 2

const NODE_MODULES = 'node_modules'
const TMP_PREFIX = '.ia-flow-node_modules-'

/** Qué quedó del `node_modules` de un worktree. */
export type DependencyStatus =
  /** No es un repo de Node (sin `package.json` o sin lockfile): no aplica. */
  | { kind: 'not-node' }
  /** Ya estaba. */
  | { kind: 'present'; lockfile: string }
  /** Se copió de `from` (una semilla o un worktree hermano). */
  | { kind: 'reused'; lockfile: string; from: string; ms: number }
  /** No hay de dónde copiar, o la copia falló (`reason`). Queda sin `node_modules`. */
  | { kind: 'missing'; lockfile: string; reason: string }

export interface NodeDependenciesOptions {
  /** `process.platform`: decide el `cp` (`darwin` clona con `-c`). Inyectable para tests. */
  platform?: NodeJS.Platform
}

/** El lockfile de `dir` y el sha256 de su contenido, si `dir` es un repo de Node. */
export function lockfileOf(dir: string): { name: string; hash: string } | undefined {
  if (!existsSync(join(dir, 'package.json'))) return undefined
  for (const name of LOCKFILES) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
    return { name, hash }
  }
  return undefined
}

/** Dónde vive la semilla de `repoBasePath` para un lockfile. `undefined` si el clone no tiene un
 *  `.git` directorio (no se siembra en un repo que es a su vez un worktree). */
export function seedPathFor(repoBasePath: string, hash: string): string | undefined {
  const gitDir = join(repoBasePath, '.git')
  try {
    if (!statSync(gitDir).isDirectory()) return undefined
  } catch {
    return undefined
  }
  return join(gitDir, 'ia-flow-deps', hash, NODE_MODULES)
}

/** Lo que el agente lee sobre sus dependencias, o nada si no hay nada que decirle. */
export function dependencyNotice(status: DependencyStatus | undefined): string | undefined {
  if (!status) return undefined
  if (status.kind === 'reused') {
    return (
      `[workspace] node_modules copiado de otro checkout con el mismo ${status.lockfile}: ` +
      'no hace falta instalar dependencias.'
    )
  }
  if (status.kind === 'missing') {
    return (
      `[workspace] sin node_modules (${status.reason}). Instalar desde cero (con el lockfile ` +
      `${status.lockfile}) puede tardar muchos minutos o fallar por red: intentalo UNA vez con ` +
      'timeout acotado; si falla, no reintentes — trabajá por lectura y decí en tu cierre qué no ' +
      'pudiste correr.'
    )
  }
  return undefined
}

export class NodeDependencies {
  readonly #platform: NodeJS.Platform

  constructor(
    private readonly shell: ShellRunner,
    opts: NodeDependenciesOptions = {},
  ) {
    this.#platform = opts.platform ?? process.platform
  }

  /**
   * Deja `node_modules` en `worktree` si falta y hay de dónde copiarlo: la semilla del repo, o el
   * primero de `siblings` (otros checkouts del mismo repo) con el mismo lockfile.
   */
  async ensure(
    worktree: string,
    repoBasePath: string,
    siblings: readonly string[],
  ): Promise<DependencyStatus> {
    const lock = lockfileOf(worktree)
    if (!lock) return { kind: 'not-node' }
    await this.#dropLeftovers(worktree)
    const target = join(worktree, NODE_MODULES)
    if (existsSync(target)) return { kind: 'present', lockfile: lock.name }

    const source = this.#sourceFor(worktree, repoBasePath, siblings, lock.hash)
    if (!source) {
      return {
        kind: 'missing',
        lockfile: lock.name,
        reason: `ningún otro checkout del repo tiene node_modules para este ${lock.name}`,
      }
    }
    const started = Date.now()
    const tmp = join(worktree, `${TMP_PREFIX}${process.pid}-${started}`)
    const r = await this.shell.run(this.#copyArgs(source, tmp), worktree).catch((err: unknown) => ({
      exitCode: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    }))
    if (r.exitCode !== 0) {
      await rm(tmp, { recursive: true, force: true })
      const detail = (r.stderr || r.stdout).trim().split('\n')[0] ?? ''
      return {
        kind: 'missing',
        lockfile: lock.name,
        reason: `no se pudo copiar de ${source}: ${detail}`,
      }
    }
    try {
      renameSync(tmp, target)
    } catch {
      // Otra corrida lo dejó primero (mismo worktree, en paralelo): vale el suyo.
      await rm(tmp, { recursive: true, force: true })
      if (existsSync(target)) return { kind: 'present', lockfile: lock.name }
      return {
        kind: 'missing',
        lockfile: lock.name,
        reason: 'no se pudo mover la copia a node_modules',
      }
    }
    return { kind: 'reused', lockfile: lock.name, from: source, ms: Date.now() - started }
  }

  /**
   * Antes de borrar `worktree`: si no hay semilla para su lockfile, su `node_modules` pasa a serlo
   * (un `rename`, no una copia). Devuelve la semilla creada, o `undefined` si no hizo nada. Las
   * semillas viejas se borran en segundo plano: un `node_modules` tarda en irse.
   */
  harvest(worktree: string, repoBasePath: string): string | undefined {
    const lock = lockfileOf(worktree)
    const source = join(worktree, NODE_MODULES)
    if (!lock || !existsSync(source)) return undefined
    const seed = seedPathFor(repoBasePath, lock.hash)
    if (!seed || existsSync(seed)) return undefined
    try {
      mkdirSync(join(seed, '..'), { recursive: true })
      renameSync(source, seed)
    } catch {
      // Otro disco (EXDEV) o permisos: sin semilla, el worktree se borra igual.
      return undefined
    }
    void this.#pruneSeeds(join(seed, '..', '..'), basename(join(seed, '..'))).catch(() => {})
    return seed
  }

  #sourceFor(
    worktree: string,
    repoBasePath: string,
    siblings: readonly string[],
    hash: string,
  ): string | undefined {
    const seed = seedPathFor(repoBasePath, hash)
    if (seed && existsSync(seed)) {
      // Usada recién: la poda la cuenta entre las nuevas.
      const now = new Date()
      try {
        utimesSync(join(seed, '..'), now, now)
      } catch {}
      return seed
    }
    for (const sibling of siblings) {
      if (sibling === worktree) continue
      const candidate = join(sibling, NODE_MODULES)
      if (existsSync(candidate) && lockfileOf(sibling)?.hash === hash) return candidate
    }
    return undefined
  }

  #copyArgs(source: string, dest: string): string[] {
    if (this.#platform === 'darwin') return ['cp', '-cR', source, dest]
    if (this.#platform === 'linux') return ['cp', '-a', '--reflink=auto', source, dest]
    return ['cp', '-R', source, dest]
  }

  /** Una copia a medias de una corrida que se cayó. */
  async #dropLeftovers(worktree: string): Promise<void> {
    for (const entry of safeReaddir(worktree)) {
      if (entry.startsWith(TMP_PREFIX))
        await rm(join(worktree, entry), { recursive: true, force: true })
    }
  }

  /** Quedan las {@link MAX_SEEDS} semillas más nuevas; `keep` (la recién creada) nunca se va. */
  async #pruneSeeds(root: string, keep: string): Promise<void> {
    const seeds = safeReaddir(root)
      .map((name) => ({ name, mtime: safeMtime(join(root, name)) }))
      .sort((a, b) => b.mtime - a.mtime)
    let kept = 0
    for (const seed of seeds) {
      if (seed.name === keep || kept < MAX_SEEDS - 1) {
        if (seed.name !== keep) kept++
        continue
      }
      await rm(join(root, seed.name), { recursive: true, force: true })
    }
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}
