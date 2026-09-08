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
// no a los hijos que abrió (`&&`, pipelines). El costo es que cada entrada de
// `verify` es UN comando (sin `&&`/pipes) — exactamente lo que ya pide la
// forma `string[]`.
//
// Ni siquiera sin shell alcanza: un comando SIN `&&` puede forkear hijos por
// su cuenta (`tsc` desde `bun run typecheck`, workers de `vitest`, `make`),
// y `kill()` sólo mata al proceso directo — un nieto vivo sostiene el pipe de
// stdout heredado abierto, así que esperar a que el stream CIERRE (como hacía
// `Response(stream).text()`) podía colgar `runOne` para siempre, reteniendo
// el lock de la task y el slot de capacidad. `readWithDeadline` reemplaza esa
// espera por un límite de reloj: lee lo que haya hasta `timeoutMs +
// HARD_DEADLINE_GRACE_MS` y se rinde ahí, cierre o no el stream — `runOne`
// SIEMPRE resuelve.
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

/**
 * Variables que matchean `SECRET_ENV_PATTERN` por nombre pero NO son un
 * secreto — son infraestructura de git/ssh que un comando de `verify` puede
 * necesitar de verdad (clonar/pushear un submódulo, `git ls-remote`). Sin
 * esta excepción, `SSH_AUTH_SOCK` (matchea "auth") desaparecía del env del
 * comando y un `verify` que necesitara red autenticada por SSH fallaba por
 * eso — un problema de entorno que el sistema reportaba como código roto.
 */
const SECRET_ENV_EXCEPTIONS = new Set(['SSH_AUTH_SOCK'])

/** Exportado sólo para tests — no usar fuera de `_verifyInternals.spawn`. */
export function buildVerifyEnv(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (SECRET_ENV_EXCEPTIONS.has(name)) {
      env[name] = value
      continue
    }
    if (SECRET_ENV_PATTERN.test(name)) continue
    env[name] = value
  }
  return env
}

/**
 * Extra que se le da a un comando después de `timeoutMs` para que sus
 * streams terminen de cerrar tras el `kill()`, antes de dejar de esperar.
 * `kill()` sólo termina el proceso directo — un comando que forkeó hijos
 * (`tsc` desde `bun run typecheck`, workers de `vitest`, `make`) puede
 * dejarlos vivos con el pipe heredado abierto, y sin este segundo límite
 * `runOne` nunca resolvería: `Response(stream).text()` espera a que el
 * pipe cierre, no a que el proceso que mata `kill()` muera.
 */
export const HARD_DEADLINE_GRACE_MS = 5_000

/** Test-only indirection — same pattern as `_execInternals` in
 *  packages/tools/src/exec/exec.ts. `timeoutMs`/`graceMs` son separadamente
 *  overridable así un test ejercita el timeout/deadline sin esperar los 60s
 *  (o los 5s de gracia) reales. */
export const _verifyInternals: {
  spawn: (argv: string[], cwd: string) => SpawnedVerifyProc
  timeoutMs: number
  graceMs: number
} = {
  spawn: (argv, cwd) =>
    Bun.spawn(argv, {
      cwd,
      env: buildVerifyEnv(Bun.env),
      stdout: 'pipe',
      stderr: 'pipe',
    }) as unknown as SpawnedVerifyProc,
  timeoutMs: VERIFY_TIMEOUT_MS,
  graceMs: HARD_DEADLINE_GRACE_MS,
}

/**
 * Lee `stream` hasta que cierra o hasta `deadlineAt` (epoch ms), lo que
 * pase primero. Deliberadamente NO usa `Response(stream).text()` —esa API
 * sólo resuelve con el cierre del stream, exactamente lo que un pipe
 * heredado por un nieto vivo nunca hace—, sino un loop de lectura manual
 * que se puede abandonar a mitad de camino sin perder lo ya leído.
 */
async function readWithDeadline(
  stream: ReadableStream<Uint8Array> | null,
  deadlineAt: number,
): Promise<string> {
  if (!stream) return ''
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const TIMED_OUT = Symbol('timed-out')
  let result = ''
  try {
    while (true) {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) break
      // El timer de esta vuelta se limpia SIEMPRE al resolver la carrera —
      // sin esto, un stream verboso (muchos chunks) deja un timer de hasta
      // `remaining` ms vivo por cada `read()` que ganó, así que un comando
      // con salida grande podía dejar cientos colgados durante el minuto
      // siguiente al fin del run.
      let raceTimer: ReturnType<typeof setTimeout>
      const next = await Promise.race([
        reader.read(),
        new Promise<typeof TIMED_OUT>((resolve) => {
          raceTimer = setTimeout(() => resolve(TIMED_OUT), remaining)
        }),
      ])
      clearTimeout(raceTimer!)
      if (next === TIMED_OUT) break
      const { done, value } = next
      if (done) break
      result += decoder.decode(value, { stream: true })
    }
  } catch {
    // el proceso murió a mitad de lectura, o el reader ya se canceló — lo
    // leído hasta acá se conserva igual.
  } finally {
    // Fire-and-forget, sin `await`: `cancel()` sobre un pipe que un nieto
    // vivo sostiene abierto no tiene garantía de resolver, y esperarlo acá
    // reintroduciría exactamente la espera ilimitada que este deadline
    // existe para evitar.
    reader.cancel().catch(() => {
      // best-effort — el stream puede ya estar cerrado, o nunca resolver
    })
  }
  // Flush final: un carácter multibyte cortado justo en el límite entre dos
  // chunks queda en el buffer interno del decoder hasta este llamado sin
  // `stream: true` — sin él, ese carácter se pierde en vez de aparecer
  // (posiblemente incompleto) al final del output.
  result += decoder.decode()
  return result
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
      proc.kill('SIGKILL')
    } catch {
      // best-effort — el proceso puede ya estar muerto
    }
  }, _verifyInternals.timeoutMs)

  // Deadline duro, independiente de si el proceso (o sus hijos) sueltan el
  // pipe: `runOne` SIEMPRE resuelve antes de `timeoutMs + graceMs`, así que
  // un comando colgado no retiene el lock de la task ni el slot de
  // capacidad para siempre — sólo hasta acá.
  const deadlineAt = Date.now() + _verifyInternals.timeoutMs + _verifyInternals.graceMs

  let exitRaceTimer: ReturnType<typeof setTimeout> | undefined
  const exitWithDeadline = Promise.race([
    proc.exited.catch(() => null as unknown as number),
    new Promise<number | null>((resolve) => {
      exitRaceTimer = setTimeout(() => resolve(null), Math.max(0, deadlineAt - Date.now()))
    }),
  ])

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    readWithDeadline(proc.stdout, deadlineAt),
    readWithDeadline(proc.stderr, deadlineAt),
    exitWithDeadline,
  ])
  clearTimeout(timer)
  clearTimeout(exitRaceTimer)

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
