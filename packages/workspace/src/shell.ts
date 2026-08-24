// Abstracción de shell para todo lo que este paquete ejecuta (git, nada más
// por ahora). Inyectada para que los tests manejen la salida de git sin tocar
// disco, y para que el mismo WorkspaceManager corra en el daemon y en el
// gateway sin arrastrar el runtime de cada host.

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
 * Implementación real sobre `Bun.spawn`. Nunca tira para exits no-cero — el
 * caller inspecciona `exitCode` (los helpers del WorkspaceManager convierten
 * los fallos de shell en errores tipados).
 */
export class BunShellRunner implements ShellRunner {
  async run(args: string[], cwd: string): Promise<ShellResult> {
    if (args.length === 0) {
      throw new Error('BunShellRunner.run called with empty args')
    }
    const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    return { stdout, stderr, exitCode }
  }
}
