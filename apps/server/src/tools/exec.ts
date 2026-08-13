// `run_command` — sandboxed shell-less command execution for the anthropic-api
// provider. Everything in this file funnels through four guards before spawn:
//
//   1. writePaths present (mirrors write_file / edit_file — no writable
//      zone means the run is read-only and exec is meaningless).
//   2. Binary in the whitelist (`COMMAND_WHITELIST`).
//   3. If it's `git`, the subcommand is not destructive / doesn't move off
//      the task branch (`assertGitSafe`).
//   4. `cwd` (explicit or defaulted to `writePaths[0]`) lives under a
//      writable path.
//
// Runtime: `Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })` — no
// `sh -c`, no shell expansion, no piping. Agents that need shell-y flows
// (pipelines, redirections) chain multiple `run_command` invocations.
//
// Timeout: default 60 s, hard cap 300 s. When the timer fires we `kill()`
// the process and return whatever stdout/stderr was buffered so far,
// suffixed with `[timeout]`.
//
// Output: stdout+stderr merged, byte-capped at 20 KB with `[truncated]`.

import { resolve } from 'node:path'
import { createLogger } from '../logger.js'
import { type ToolContext, registerTool } from './index.js'

const log = createLogger('tool-exec')

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Binaries the agent may spawn. Everything else is rejected before spawn
 * with `binario no permitido: <cmd>`. Kept intentionally narrow — new
 * entries should be a conscious call, not a "just in case" default.
 */
export const COMMAND_WHITELIST: ReadonlySet<string> = new Set([
  'bun',
  'bunx',
  'node',
  'npm',
  'pnpm',
  'git',
  'go',
  'uv',
  'pytest',
  'ruff',
  'rg',
  'cat',
  'ls',
  'head',
  'tail',
  'find',
  'make',
])

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
 * redirection, glob expansion) it must chain multiple `run_command`
 * invocations.
 */
export function parseArgv(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean)
}

/** Throws `binario no permitido: <cmd>` when `argv[0]` isn't in the
 *  whitelist. Empty argv → `comando vacío` (defensive; callers should
 *  short-circuit earlier). */
export function assertBinaryAllowed(argv: string[]): void {
  const bin = argv[0]
  if (!bin) throw new Error('comando vacío')
  if (!COMMAND_WHITELIST.has(bin)) {
    throw new Error(`binario no permitido: ${bin}`)
  }
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
 * Reject destructive git subcommands or ones that would move the sandbox
 * off the task branch. No-op for non-`git` argv. All rules run *before*
 * spawn — parity with the whitelist and writePaths guards.
 *
 * Blocked:
 *   - `git checkout …`, `git switch …` (branch changes)
 *   - `git branch -d/-D …` (branch deletion)
 *   - `git worktree remove …` (worktree destruction)
 *   - `git reset --hard …` (working-tree wipe)
 *   - `git push <remote> <branch>` where <branch> is not `HEAD`,
 *     `task/*`, or a refspec whose source side is `HEAD` / `task/*`.
 */
export function assertGitSafe(argv: string[]): void {
  if (argv[0] !== 'git') return
  const sub = argv[1]
  if (!sub) return

  if (sub === 'checkout' || sub === 'switch') {
    throw new Error(`git ${sub} bloqueado: sale de la rama del task`)
  }

  if (sub === 'branch' && (argv.includes('-d') || argv.includes('-D'))) {
    throw new Error('git branch -d/-D bloqueado: borrar ramas es destructivo')
  }

  if (sub === 'worktree' && argv[2] === 'remove') {
    throw new Error('git worktree remove bloqueado: destruye el sandbox del task')
  }

  if (sub === 'reset' && argv.includes('--hard')) {
    throw new Error('git reset --hard bloqueado: destruye el estado del worktree')
  }

  if (sub === 'push') {
    // Shape variants we want to allow:
    //   git push
    //   git push origin
    //   git push origin HEAD
    //   git push origin task/<id>
    //   git push -u origin task/<id>
    //   git push origin HEAD:refs/heads/task/<id>
    // Blocked: anything with an explicit refspec whose source side is
    // outside HEAD / task/*.
    const positionals = argv.slice(2).filter((a) => !a.startsWith('-'))
    const refspec = positionals[1]
    if (!refspec) return
    const src = refspec.includes(':') ? refspec.split(':')[0] : refspec
    const dst = refspec.includes(':') ? refspec.split(':')[1] : ''
    const isTaskRef = (r: string) =>
      r === 'HEAD' ||
      r.startsWith('task/') ||
      r === '' ||
      r.startsWith('refs/heads/task/') ||
      r === 'refs/heads/HEAD'
    if (!isTaskRef(src) || (dst && !isTaskRef(dst))) {
      throw new Error(`git push a rama fuera del task bloqueado: ${refspec}`)
    }
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
  name: 'run_command',
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
    'Sin shell (Bun.spawn con argv), sin pipes/redirect/glob expansion — encadená múltiples run_command si necesitás un pipeline.',
    `El primer token debe estar en la whitelist: ${[...COMMAND_WHITELIST].join(', ')}.`,
    '`cwd` opcional: si se omite se usa el primer entry de writePaths (típicamente el worktree del task); si se especifica debe estar dentro de writePaths.',
    `\`timeout_ms\` opcional: default ${DEFAULT_TIMEOUT_MS}, cap ${MAX_TIMEOUT_MS}. Al vencer se mata el proceso y se retorna la salida parcial con marca [timeout].`,
    `stdout + stderr combinados se truncan a ${OUTPUT_MAX_BYTES} bytes con marca [truncated].`,
    'Operaciones git destructivas o que salgan de la rama del task (checkout, switch, branch -d/-D, worktree remove, reset --hard, push a otra rama) se rechazan antes de ejecutar.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'Comando + args separados por espacio. Sin quoting/expansion — el primer token es el binario y debe estar en la whitelist.',
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
      return 'run_command failed: escritura no permitida en fase actual'
    }

    if (typeof input.command !== 'string' || input.command.trim().length === 0) {
      return 'run_command failed: command es requerido y debe ser un string no vacío'
    }

    const argv = parseArgv(input.command)
    if (argv.length === 0) {
      return 'run_command failed: comando vacío'
    }

    // Guards 2–4: whitelist, git safety, cwd scope. Any throw becomes a
    // stable `run_command failed: <reason>` string so the agent can react
    // without a try/catch.
    let cwd: string
    try {
      assertBinaryAllowed(argv)
      assertGitSafe(argv)
      cwd = assertCwdInWritePaths(input.cwd, ctx.writePaths)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `run_command failed: ${msg}`
    }

    const timeoutMs = normalizeTimeoutMs(input.timeout_ms)

    log.info({ argv, cwd, timeoutMs, taskId: ctx.taskId }, 'run_command spawn')

    let proc: SpawnedProc
    try {
      proc = _execInternals.spawn(argv, cwd)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `run_command failed: spawn error: ${msg}`
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
