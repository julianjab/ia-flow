// Abstracción de shell para todo lo que este paquete ejecuta (git, nada más
// por ahora). Inyectada para que los tests manejen la salida de git sin tocar
// disco, y para que el mismo WorkspaceManager corra en el daemon y en el
// agent-host sin arrastrar el runtime de cada host.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { memoize } from '@ia-flow/shared'

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface ShellRunner {
  /** Corre `argv[0]` con `argv[1..]` en `cwd`. Nunca tira por exit != 0. */
  run(args: string[], cwd: string): Promise<ShellResult>
}

/**
 * Lee la versión de Node que el repo declara (`.nvmrc` o `engines.node` de
 * `package.json`), sólo en la raíz de `cwd` — un worktree es siempre un
 * checkout completo, así que no hace falta subir directorios. `fnm` sólo
 * resuelve versiones exactas o un major suelto ("20"), nunca un rango
 * semver — de ahí el `match` para quedarnos con el primer número de la
 * declaración (`^20.11.0` → `20.11.0`, `>=20` → `20`).
 */
function declaredNodeVersion(cwd: string): string | undefined {
  let raw: string | undefined
  try {
    raw = readFileSync(join(cwd, '.nvmrc'), 'utf8').trim()
  } catch {
    // sin .nvmrc — probamos package.json
  }
  if (!raw) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
      const engine = pkg?.engines?.node
      if (typeof engine === 'string' && engine) raw = engine
    } catch {
      // sin package.json, o sin engines — el repo no declara nada
    }
  }
  if (!raw) return undefined
  return raw.match(/\d+(?:\.\d+(?:\.\d+)?)?/)?.[0]
}

/**
 * Un `git commit` puede disparar hooks (husky) que corren `yarn`/`npm`, y
 * esos procesos heredan el PATH del daemon — típicamente el Node que `fnm`
 * dejó activo al bootear, no el que el repo target declara. Sin esto, un
 * hook de un repo con `engines.node` distinto al del daemon falla con
 * "incompatible environment" para CUALQUIER commit (agente o autosalvage).
 *
 * Best-effort y cacheado por `cwd`: sin `fnm` instalado, sin versión
 * declarada, o sin esa versión instalada, corre con el PATH heredado tal
 * cual — nunca bloquea el comando.
 */
class NodeVersionResolver {
  @memoize({ ttlMs: 5 * 60_000 })
  async binDirFor(cwd: string): Promise<string | undefined> {
    const version = declaredNodeVersion(cwd)
    if (!version) return undefined
    try {
      // `fnm which` no existe como subcomando — la forma soportada es
      // correr node bajo `fnm exec` y preguntarle su propio binario.
      const proc = Bun.spawn(
        [
          'fnm',
          'exec',
          `--using=${version}`,
          '--',
          'node',
          '-e',
          'process.stdout.write(process.execPath)',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      // Hay que drenar los dos pipes en paralelo — si `fnm`/`node` llenaran
      // el buffer de stderr sin que nadie lo lea, el proceso queda
      // bloqueado escribiendo y `exited` nunca resuelve.
      const [stdout] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited
      if (exitCode !== 0) return undefined
      const nodeBin = stdout.trim()
      return nodeBin ? dirname(nodeBin) : undefined
    } catch {
      return undefined
    }
  }
}

const nodeVersionResolver = new NodeVersionResolver()

/**
 * Implementación real sobre `Bun.spawn`. Nunca tira para exits no-cero — el
 * caller inspecciona `exitCode` (los helpers del WorkspaceManager convierten
 * los fallos de shell en errores tipados).
 */
export class BunShellRunner implements ShellRunner {
  async run(args: string[], cwd: string): Promise<ShellResult> {
    if (args.length === 0) {
      throw new Error('BunShellRunner.run called with empty args')
    }
    const env = await this.#envFor(cwd)
    const proc = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    return { stdout, stderr, exitCode }
  }

  async #envFor(cwd: string): Promise<Record<string, string | undefined>> {
    const binDir = await nodeVersionResolver.binDirFor(cwd)
    if (!binDir) return Bun.env
    // Un componente vacío en PATH significa "directorio actual" — con un
    // PATH heredado vacío, `${binDir}:` solo dejaría eso en vez del binDir.
    const path = Bun.env.PATH ? `${binDir}:${Bun.env.PATH}` : binDir
    return { ...Bun.env, PATH: path }
  }
}
