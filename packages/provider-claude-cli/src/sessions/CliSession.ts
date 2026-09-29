/** Cómo lanzar una sesión del CLI. */
export interface LaunchSpec {
  /** El binario (`claude`). */
  bin: string
  /** Los flags comunes (`SessionFiles.argv`); cada modo suma los suyos. */
  argv: string[]
  /** El prompt del turno: el del agente, o lo que pasó si se retoma. */
  promptFile: string
  /** El worktree de la task. */
  cwd: string
  /** Para nombrar la sesión (`<agente>-task-<n>`). */
  label: string
  /** Sólo tmux: traerla al frente en iTerm. */
  surface?: boolean
}

/** Cómo terminó el proceso: su código (si se sabe) y lo que escribió, para el resumen. */
export interface SessionExit {
  code: number | null
  output: string
}

/** Una sesión lanzada: cuándo terminó sola, y cómo cortarla. */
export interface CliSession {
  readonly exited: Promise<SessionExit>
  /** Para los logs: `tmux attach -t …`, `pid 123`. */
  readonly describe: string
  close(): Promise<void>
}

export interface Launcher {
  launch(spec: LaunchSpec): Promise<CliSession>
}

/** El ambiente del CLI: el del runner sin `ANTHROPIC_API_KEY` — así gana la credencial OAuth
 *  (`CLAUDE_CODE_OAUTH_TOKEN`) y no se factura por API. */
export function cliEnv(): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _drop, ...env } = process.env
  return env
}
