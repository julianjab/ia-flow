export interface ShellRunResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface ShellRunOptions {
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
}

/**
 * Correr un proceso — lo necesitan `ScriptAction.run` (correr un script del
 * repo) y `Agent.verifyWorktree` (correr `Agent.verify[]`). El pipeline/
 * engine layer nunca importa `bun:subprocess`/`node:child_process` directo;
 * el composition root del proceso que hidrata Pipelines es quien setea un
 * ShellRunner real (spawnear, con el allow/deny de policy ya aplicado).
 */
export interface ShellRunner {
  run(command: string, args: string[], opts: ShellRunOptions): Promise<ShellRunResult>
}

let current: ShellRunner | undefined

export function setShellRunner(runner: ShellRunner | undefined): void {
  current = runner
}

export function getShellRunner(): ShellRunner | undefined {
  return current
}
