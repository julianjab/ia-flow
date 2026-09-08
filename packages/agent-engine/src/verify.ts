// El "verify gate": comandos que el ENGINE corre en el worktree después del
// loop y antes de aplicar la salida de éxito de un run sync (ver
// AgentDefinition.verify, y su consumo en Agent.ts).
//
// No importa `packages/tools/src/exec/exec.ts` (`bash_run`) a propósito: la
// dependencia va al revés (`tools` importa `agent-engine`, nunca al revés),
// así que esto duplica el spawn mínimo. A diferencia de `bash_run` corre con
// la autoridad del engine, no del modelo: sin policy check ni writePaths
// gate, y con shell (`sh -c`) porque el operador —no el modelo— escribe estos
// comandos en la config del agente.
//
// Mismos límites que `bash_run` por consistencia: timeout default 60s, cap
// 300s, output combinado (stdout+stderr) truncado a 20 KB.

import { createLogger } from './logger.js'

const log = createLogger('verify')

export const VERIFY_TIMEOUT_MS = 60_000
export const VERIFY_MAX_TIMEOUT_MS = 300_000
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

/** Test-only indirection — same pattern as `_execInternals` in
 *  packages/tools/src/exec/exec.ts. `timeoutMs` is separately overridable so
 *  a test can exercise the timeout path without waiting out the real 60s. */
export const _verifyInternals: {
  spawn: (command: string, cwd: string) => SpawnedVerifyProc
  timeoutMs: number
} = {
  spawn: (command, cwd) =>
    Bun.spawn(['/bin/sh', '-c', command], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    }) as unknown as SpawnedVerifyProc,
  timeoutMs: VERIFY_TIMEOUT_MS,
}

async function runOne(command: string, cwd: string): Promise<VerifyCommandResult> {
  const proc = _verifyInternals.spawn(command, cwd)
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
