// Primitiva de ejecución de scripts: recibe un input (qué correr, con qué
// argv/env, en qué cwd) y devuelve stdout/stderr/exitCode. No sabe de
// eventos, reglas, tasks, secretos ni workspaces de git — eso es
// responsabilidad de quien arma el `RunScriptInput` (hoy, `ScriptAction`;
// mañana, cualquier otro caller que necesite correr un script con un
// contrato input → output, sin ligarse a la rueda de reglas).

export type ScriptRuntime = 'bash' | 'python'

export const SCRIPT_INTERPRETERS: Record<ScriptRuntime, string[]> = {
  bash: ['bash'],
  // `-u`: sin buffer, para que la salida llegue completa aunque el proceso se
  // mate por timeout.
  python: ['python3', '-u'],
}

const OUTPUT_MAX_BYTES = 20 * 1024
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 300_000

export interface RunScriptInput {
  /** Ruta ABSOLUTA del script a correr. La resolución/validación de que esa
   *  ruta cae dentro de algún límite (un workspace, un directorio de
   *  scripts) es del caller — acá no hay noción de "afuera". */
  file: string
  runtime: ScriptRuntime
  /** Directorio de trabajo del proceso hijo. */
  cwd: string
  args?: string[]
  /** Env COMPLETO del proceso hijo (más `PATH` si no lo trae). Sin
   *  allow-list acá: quien arma el input decide qué hereda el script. */
  env?: Record<string, string>
  timeoutMs?: number
}

export interface RunScriptResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  /** stdout+stderr recortado a `OUTPUT_MAX_BYTES`, para logs/resúmenes. */
  combined: string
}

export interface RunScriptDeps {
  /** Inyectable para testear sin spawnear de verdad. */
  spawn?: typeof Bun.spawn
}

function truncate(out: string): string {
  const bytes = Buffer.from(out)
  if (bytes.length <= OUTPUT_MAX_BYTES) return out
  return `${bytes.subarray(0, OUTPUT_MAX_BYTES).toString()}\n[truncated]`
}

/**
 * Corre un script SIN shell (`Bun.spawn([bin, ...argv])`, nunca `sh -c`): sin
 * expansión ni inyección por interpolar valores en `args`/`env`.
 */
export async function runScript(
  input: RunScriptInput,
  deps: RunScriptDeps = {},
): Promise<RunScriptResult> {
  const [bin, ...binArgs] = SCRIPT_INTERPRETERS[input.runtime]
  const argv = [bin, ...binArgs, input.file, ...(input.args ?? [])]
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(input.env ?? {}),
  }
  const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const spawn = deps.spawn ?? Bun.spawn

  const proc = spawn(argv, { cwd: input.cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const combined = truncate([stdout, stderr].filter(Boolean).join('\n').trim())
    return { ok: exitCode === 0, exitCode, stdout, stderr, combined }
  } finally {
    clearTimeout(timer)
  }
}
