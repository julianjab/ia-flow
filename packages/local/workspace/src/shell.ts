/**
 * La abstracción de shell para todo lo que este paquete ejecuta (git, nada más). Inyectada para
 * que los tests manejen la salida de git sin tocar disco, y para que el `WorkspaceManager` no
 * dependa del runtime del host.
 */
import { spawn } from 'node:child_process'

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
 * Implementación sobre `child_process.spawn`, sin shell (`shell: false`): los args viajan tal
 * cual, sin expansión ni metacaracteres. Nunca tira por un exit no-cero — el caller mira
 * `exitCode` (los helpers del `WorkspaceManager` convierten los fallos en errores tipados); sólo
 * tira si el binario no existe.
 *
 * Reemplaza al `BunShellRunner` de ia-flow. Lo que NO se portó: su resolución de la versión de
 * Node del repo con `fnm` para los hooks de `git commit` (husky). Acá los hooks corren con el
 * `PATH` del proceso.
 */
export class NodeShellRunner implements ShellRunner {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  run(args: string[], cwd: string): Promise<ShellResult> {
    const [command, ...rest] = args
    if (!command) throw new Error('NodeShellRunner.run: args vacíos')
    return new Promise((resolve, reject) => {
      const child = spawn(command, rest, { cwd, env: this.env, shell: false })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', reject)
      child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }))
    })
  }
}
