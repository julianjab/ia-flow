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
 * Reject global git flags that redirect scope away from the sandbox — `-C
 * /elsewhere`, `--git-dir=…`, `--work-tree=…`. All three defeat
 * `assertCwdInWritePaths` and any allow/deny pattern that assumes the repo
 * is the task worktree, so they are always rejected regardless of the
 * agent's `bash_run` config — this is sandbox integrity, not a capability
 * the agent can opt into.
 */
function assertNoScopeChangingGitFlags(argv: string[]): void {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-C' || a === '--git-dir' || a === '--work-tree') {
      throw new Error(`git flag no permitido: ${a} (redirige el sandbox fuera del worktree)`)
    }
    if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) {
      const flag = a.split('=')[0]
      throw new Error(`git flag no permitido: ${flag} (redirige el sandbox fuera del worktree)`)
    }
    // Boundary between global flags and the subcommand.
    if (!a.startsWith('-')) break
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
  if (argv[0] === 'git') assertNoScopeChangingGitFlags(argv)
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

    let proc: SpawnedProc
    try {
      proc = _execInternals.spawn(argv, cwd)
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
