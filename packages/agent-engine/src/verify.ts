// El "verify gate": comandos que el ENGINE corre en el worktree después del
// loop y antes de aplicar la salida de éxito de un run sync (ver
// AgentDefinition.verify, y su consumo en Agent.ts).
//
// No importa `packages/tools/src/exec/exec.ts` (`bash_run`) a propósito: la
// dependencia va al revés (`tools` importa `agent-engine`, nunca al revés),
// así que esto duplica el spawn mínimo. A diferencia de `bash_run` corre con
// la autoridad del engine, no del modelo: sin policy check ni writePaths gate.
//
// Sin shell — `Bun.spawn(argv)` directo, igual que `bash_run` — a propósito:
// con `/bin/sh -c <comando>` un `kill()` sobre el timeout mata sólo al `sh`,
// no a los hijos que abrió (`&&`, pipelines), que quedan vivos con el pipe de
// stdout abierto y cuelgan `runOne` para siempre reteniendo el lock de la
// task. Sin shell, `kill()` termina el proceso real y el timeout es efectivo.
// El costo es que cada entrada de `verify` es UN comando (sin `&&`/pipes) —
// exactamente lo que ya pide la forma `string[]`.
//
// Mismos límites que `bash_run` por consistencia: timeout 60s fijo (no hay
// override por comando — a diferencia de `bash_run`, `verify` no es un tool
// call con `timeout_ms`), output combinado (stdout+stderr) truncado a 20 KB.
//
// El env del spawn NO es el del daemon completo — ver `buildVerifyEnv` más
// abajo — porque ese output, a diferencia del de `bash_run`, va derecho a un
// comentario público sin que el modelo lo medie.

import { createLogger } from './logger.js'

const log = createLogger('verify')

export const VERIFY_TIMEOUT_MS = 60_000
export const VERIFY_OUTPUT_MAX_BYTES = 20 * 1024

/** Marca estable al frente del mensaje de error que dispara este path — es
 *  lo que `classifyFailure` (failure-taxonomy.ts) matchea para asignar
 *  `failureClass: 'verify_failed'` sin que este módulo dependa de ese otro. */
export const VERIFY_FAILED_MARKER = 'verify_failed:'

export interface VerifyCommandResult {
  command: string
  exitCode: number | null
  output: string
  timedOut: boolean
}

export interface VerifyRunResult {
  ok: boolean
  results: VerifyCommandResult[]
}

/** Same byte-based truncation contract as `bash_run` — stable `[truncated]`
 *  marker so downstream matchers can find it verbatim. */
function truncateOutput(text: string, maxBytes: number = VERIFY_OUTPUT_MAX_BYTES): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text
  const buf = Buffer.from(text, 'utf-8').subarray(0, maxBytes)
  return buf.toString('utf-8') + '\n[truncated]'
}

export interface SpawnedVerifyProc {
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
  exited: Promise<number>
  kill: (signal?: number | string) => void
}

/**
 * Split naive por whitespace — no es `parseArgv` de `bash_run` (sin comillas,
 * sin escapes): estos comandos los escribe el operador en la config del
 * agente ("bun run typecheck", "bun test"), no el modelo, así que no hace
 * falta la gramática mínima que ahí evita el bug de `git commit -m "..."`.
 * Un comando que de verdad necesite un argumento con espacios se escribe como
 * dos entradas de `verify` (una por comando) en vez de una con `&&`.
 */
function splitCommand(command: string): string[] {
  return command.split(/\s+/).filter(Boolean)
}

/**
 * Nombres de variable que huelen a credencial — coincide con `GITHUB_TOKEN`,
 * `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, y cualquier secreto de MCP que el
 * daemon haya interpolado a su propio env. Hasta 20 KB de stdout+stderr de
 * este spawn terminan en un comentario PÚBLICO del issue/PR (`postError`), así
 * que lo que el proceso hijo puede leer del env es lo que un comando verboso
 * (`set -x`, un test que dumpea su config) puede filtrar ahí. `Bun.spawn` sin
 * `env` hereda el proceso completo del daemon — por eso este módulo arma el
 * suyo en vez de dejarlo pasar tal cual.
 *
 * Un allowlist habría sido más angosto, pero un comando de `verify` es código
 * del operador (bun/npm/make/pytest…) con necesidades de env impredecibles
 * (PATH, HOME, proxies, config de npm/pip); un allowlist incompleto rompe
 * comandos legítimos con un fallo silencioso y confuso. El blocklist cubre
 * los nombres reales que este proceso usa.
 */
const SECRET_ENV_PATTERN = /token|key|secret|password|passwd|credential|auth/i

/** Exportado sólo para tests — no usar fuera de `_verifyInternals.spawn`. */
export function buildVerifyEnv(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (SECRET_ENV_PATTERN.test(name)) continue
    env[name] = value
  }
  return env
}

/** Test-only indirection — same pattern as `_execInternals` in
 *  packages/tools/src/exec/exec.ts. `timeoutMs` is separately overridable so
 *  a test can exercise the timeout path without waiting out the real 60s. */
export const _verifyInternals: {
  spawn: (argv: string[], cwd: string) => SpawnedVerifyProc
  timeoutMs: number
} = {
  spawn: (argv, cwd) =>
    Bun.spawn(argv, {
      cwd,
      env: buildVerifyEnv(Bun.env),
      stdout: 'pipe',
      stderr: 'pipe',
    }) as unknown as SpawnedVerifyProc,
  timeoutMs: VERIFY_TIMEOUT_MS,
}

async function runOne(command: string, cwd: string): Promise<VerifyCommandResult> {
  const argv = splitCommand(command)
  if (argv.length === 0) {
    return { command, exitCode: null, output: 'comando vacío', timedOut: false }
  }
  const proc = _verifyInternals.spawn(argv, cwd)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill()
    } catch {
      // best-effort — el proceso puede ya estar muerto
    }
  }, _verifyInternals.timeoutMs)

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text().catch(() => '') : Promise.resolve(''),
    proc.stderr ? new Response(proc.stderr).text().catch(() => '') : Promise.resolve(''),
    proc.exited.catch(() => null as unknown as number),
  ])
  clearTimeout(timer)

  const combined = [stdoutText, stderrText].filter((s) => s.length > 0).join('\n')
  return {
    command,
    exitCode,
    output: truncateOutput(combined) + (timedOut ? '\n[timeout]' : ''),
    timedOut,
  }
}

/**
 * Corre `commands` EN SERIE dentro de `cwd`, cortando en el primero que no
 * sale con exit 0 — seguir con el resto no aporta nada una vez que uno ya
 * probó que el worktree no compila/testea.
 */
export async function runVerifyCommands(commands: string[], cwd: string): Promise<VerifyRunResult> {
  const results: VerifyCommandResult[] = []
  for (const command of commands) {
    const result = await runOne(command, cwd)
    results.push(result)
    log.info({ command, exitCode: result.exitCode, cwd }, 'verify command finished')
    if (result.exitCode !== 0) {
      return { ok: false, results }
    }
  }
  return { ok: true, results }
}

/**
 * El `Error` que `Agent.ts` lanza cuando `runVerifyCommands` falla, para que
 * el catch genérico del run lo trate como cualquier otro fallo (postError +
 * lifecycle.fail) — la única diferencia es el `failureClass` que
 * `classifyFailure` le asigna por la marca al frente del mensaje.
 */
export function buildVerifyFailedError(result: VerifyRunResult, totalCommands: number): Error {
  const failed = result.results[result.results.length - 1]
  const header = failed
    ? `comando ${result.results.length}/${totalCommands} "${failed.command}" salió con exit=${failed.exitCode ?? 'unknown'}`
    : 'sin comandos ejecutados'
  const body = failed ? failed.output : ''
  return new Error([`${VERIFY_FAILED_MARKER} ${header}`, body].filter(Boolean).join('\n\n'))
}
