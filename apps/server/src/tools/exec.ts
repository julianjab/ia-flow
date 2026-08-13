// run_command — sandboxed shell execution for the anthropic-api tool loop.
//
// Scope: only tools that are inherently mutating live here. The read-only
// tools (`read_file`, `list_dir`, `grep_files`) are in `fs.ts` and don't need
// a writable zone. `run_command` requires `ctx.writePaths` to be non-empty
// (same guard `write_file` / `edit_file` use, so agents get a uniform
// contract across all write tools).
//
// Design notes:
//   • Argv parsing is a naive whitespace split — never `sh -c`, no
//     interpolation, no globbing, no pipes. The agent composes multi-step
//     workflows by issuing multiple `run_command` calls.
//   • The binary allow-list is closed; new binaries are opt-in additions.
//   • Bun.spawn is threaded through `_execInternals.spawn` so tests can drive
//     stdout/stderr/exit/timeout without depending on the host having each
//     binary installed (mirrors the `_grepInternals` seam in fs.ts).

import { resolve } from 'node:path'
import { createLogger } from '../logger.js'
import { type ToolContext, registerTool } from './index.js'

const log = createLogger('tool-exec')

// ─── Configuration ────────────────────────────────────────────────────────

/**
 * Closed allow-list. Any first-token binary outside this set is rejected
 * before spawn. Kept as a `Set<string>` for O(1) membership.
 *
 * When adding a binary, prefer runners over interpreters (bun/npm over
 * spawning arbitrary node scripts) and think about the blast radius: a
 * binary landing here inherits the writePaths sandbox but nothing prevents
 * it from launching subprocesses of its own.
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

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 300_000
/** Combined stdout+stderr byte cap. Kept well under `MAX_TOOL_RESULT_BYTES`
 *  (100 KB) in `index.ts` so callers see the `[truncated]` marker land from
 *  this tool, not from the loop-level defensive cap. */
const MAX_OUTPUT_BYTES = 20_000

// ─── Helpers (exported for tests) ─────────────────────────────────────────

/**
 * Naive argv split — whitespace-delimited, no quote handling, no env
 * expansion. Deliberate: the agent must pass simple commands; if it needs
 * anything more it should invoke `run_command` multiple times.
 */
export function parseArgv(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
}

export function assertBinaryAllowed(argv: string[]): void {
  const cmd = argv[0]
  if (!cmd || !COMMAND_WHITELIST.has(cmd)) {
    throw new Error(`binario no permitido: ${cmd ?? '(vacío)'}`)
  }
}

/**
 * True iff `cwd` (resolved to an absolute path) equals or lives under any
 * of the `writePaths` roots. Used both directly by `run_command` and
 * indirectly by tests.
 */
export function assertCwdInWritePaths(cwd: string, writePaths: string[]): void {
  const abs = resolve(cwd)
  const ok = writePaths.some((wp) => {
    const wpAbs = resolve(wp)
    return abs === wpAbs || abs.startsWith(wpAbs + '/')
  })
  if (!ok) {
    throw new Error(
      `cwd fuera de writePaths: ${cwd} (permitidos: ${writePaths.join(', ') || '(vacío)'})`,
    )
  }
}

/**
 * Blocks git operations that would either take the worktree off `task/<id>`
 * or destroy work that lives on a branch. Matches the PRD:
 *   - `checkout` / `switch`  → always blocked (branch-switch escape)
 *   - `branch -d/-D/--delete` → blocked (branch destruction)
 *   - `worktree remove` / `worktree prune` → blocked (use `reset_worktree`)
 *   - `reset --hard` without pathspec → blocked (blanket reset; use
 *     `reset_worktree` when the intent is to nuke the tree)
 *   - `push <remote> <ref>` when `<ref>` isn't `HEAD` or `task/*` (or the
 *     specific `task/<taskId>` when known) → blocked (would push work to
 *     the wrong branch)
 *
 * `taskId` is optional so the guard degrades gracefully when the caller
 * hasn't wired `ctx.taskId` — the `task/*` prefix rule still catches the
 * common case.
 */
export function assertGitSafe(argv: string[], taskId?: string): void {
  if (argv[0] !== 'git') return
  const sub = argv[1]
  const rest = argv.slice(2)
  const isFlag = (s: string) => s.startsWith('-')

  if (sub === 'checkout' || sub === 'switch') {
    throw new Error(`git ${sub} está bloqueado: cambiar de rama saldría de task/<id>`)
  }

  if (sub === 'branch' && rest.some((a) => a === '-d' || a === '-D' || a === '--delete')) {
    throw new Error('git branch -d/-D está bloqueado (borrado de branches)')
  }

  if (sub === 'worktree' && (rest[0] === 'remove' || rest[0] === 'prune')) {
    throw new Error(`git worktree ${rest[0]} está bloqueado — usar la herramienta reset_worktree`)
  }

  if (sub === 'reset' && rest.includes('--hard')) {
    // Allow when there's a pathspec (an explicit `--` separator, or a
    // positional after `--hard` that isn't a ref-ish). This preserves
    // legitimate uses like `git reset --hard -- path/to/file`. A blanket
    // `git reset --hard [<ref>]` is blocked in favor of `reset_worktree`.
    const hardIdx = rest.indexOf('--hard')
    const after = rest.slice(hardIdx + 1)
    const hasSeparator = after.includes('--')
    const hasPathspec = after.some(
      (a) =>
        !isFlag(a) &&
        !/^[0-9a-f]{7,40}$/i.test(a) &&
        a !== 'HEAD' &&
        !a.startsWith('HEAD~') &&
        !a.startsWith('HEAD^') &&
        !a.startsWith('origin/'),
    )
    if (!hasSeparator && !hasPathspec) {
      throw new Error(
        'git reset --hard sin path está bloqueado — usar la herramienta reset_worktree para descartar todo',
      )
    }
  }

  if (sub === 'push') {
    const positional = rest.filter((a) => !isFlag(a))
    // `git push` / `git push origin` → allowed.
    // `git push origin <ref>` → check ref.
    if (positional.length >= 2) {
      const ref = positional[1]
      // Handle src:dst — check the destination side.
      const parts = ref.split(':')
      const targetRef = parts[parts.length - 1]
      const isTaskBranch = targetRef === 'HEAD' || targetRef.startsWith('task/')
      const isExactTaskBranch = taskId ? targetRef === `task/${taskId}` : false
      if (!isTaskBranch && !isExactTaskBranch) {
        throw new Error(
          `git push a rama distinta de task/<id> está bloqueado: ${ref}` +
            (taskId ? ` (esperado task/${taskId} o HEAD)` : ''),
        )
      }
    }
  }
}

// ─── Spawn seam (test-only) ───────────────────────────────────────────────

/**
 * Subset of Bun's Subprocess we actually consume. Kept as a structural type
 * so the spawn seam accepts either a real `Bun.Subprocess` or a test double
 * without forcing the whole surface on stubs.
 */
export interface ExecSubprocess {
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
  exited: Promise<number>
  kill: (signal?: number | string) => void
}

/**
 * Overridable in tests. `_execInternals.spawn = mySpawn` lets us return a
 * deterministic subprocess without depending on the host having each binary
 * installed nor on real timers/kill signals.
 */
export const _execInternals: {
  spawn: (
    argv: string[],
    opts: { cwd: string; stdout: 'pipe'; stderr: 'pipe' },
  ) => ExecSubprocess
} = {
  spawn: (argv, opts) => Bun.spawn(argv, opts) as unknown as ExecSubprocess,
}

// ─── Output shaping ───────────────────────────────────────────────────────

/**
 * Byte-based truncation. Uses `Buffer.byteLength` for the comparison and
 * `Buffer.from(...).toString('utf-8', 0, cap)` for the slice — the trailing
 * bytes may cut mid-codepoint, but the `[truncated]` marker makes that
 * acceptable and the loop compaction step never re-parses the payload.
 */
export function truncateOutput(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf-8')
  if (bytes <= MAX_OUTPUT_BYTES) return text
  const buf = Buffer.from(text, 'utf-8')
  const sliced = buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf-8')
  return `${sliced}\n[truncated]`
}

/** Drains a stdout/stderr `ReadableStream` into a UTF-8 string. Returns `''`
 *  when the stream is missing or throws — a spawn failure surfaces via
 *  `exited`, not here. */
async function drainStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ''
  try {
    return await new Response(stream).text()
  } catch {
    return ''
  }
}

// ─── Tool ─────────────────────────────────────────────────────────────────

interface RunCommandInput {
  command: string
  cwd?: string
  timeout_ms?: number
}

const WHITELIST_LIST = [...COMMAND_WHITELIST].join(', ')

registerTool({
  name: 'run_command',
  // Sync-only: relies on `ctx.writePaths` (built by AgentOrchestrator for the
  // anthropic-api provider). Terminal providers get an empty ToolContext, so
  // exposing the tool there would just refuse — filter it out at the
  // registry level to keep the async curl appendix clean.
  providerKinds: ['sync'],
  description: [
    'Ejecuta un comando dentro del worktree del task (sandbox writePaths).',
    'Sin shell interpolation, sin pipes, sin globbing — el primer token debe estar en la whitelist',
    `(${WHITELIST_LIST}).`,
    `Timeout default ${DEFAULT_TIMEOUT_MS} ms, cap ${MAX_TIMEOUT_MS} ms.`,
    `Output combinado stdout+stderr se trunca a ${MAX_OUTPUT_BYTES} bytes con marca [truncated].`,
    'Operaciones git destructivas (checkout, switch, branch -d, worktree remove/prune,',
    'reset --hard sin path, push a rama distinta de task/<id>) son rechazadas antes de ejecutar.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'Comando a ejecutar. Se parsea en argv por whitespace; el primer token debe estar en la whitelist.',
      },
      cwd: {
        type: 'string',
        description:
          'Directorio de trabajo absoluto. Debe estar dentro de writePaths. Default: primer writePaths entry.',
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

    // Shared write-phase guard. Empty / undefined writePaths → the run is in
    // a read-only phase (Refine, Test) and mutating tools must refuse.
    const writePaths = ctx.writePaths ?? []
    if (writePaths.length === 0) {
      return 'Error: escritura no permitida en fase actual'
    }

    if (typeof input.command !== 'string' || input.command.trim() === '') {
      return 'Error: command es requerido y no puede estar vacío'
    }

    const argv = parseArgv(input.command)
    if (argv.length === 0) {
      return 'Error: command vacío después de parsear'
    }

    let cwd: string
    try {
      assertBinaryAllowed(argv)
      cwd = input.cwd ?? writePaths[0]
      assertCwdInWritePaths(cwd, writePaths)
      assertGitSafe(argv, ctx.taskId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error: ${msg}`
    }

    const requestedTimeout = input.timeout_ms ?? DEFAULT_TIMEOUT_MS
    const timeoutMs = Math.min(Math.max(requestedTimeout, 1), MAX_TIMEOUT_MS)
    const absCwd = resolve(cwd)

    log.info(
      { argv, cwd: absCwd, timeoutMs, taskId: ctx.taskId, writePaths },
      'run_command spawn',
    )

    // Declared outside the try so the `finally` can clear the timer even if
    // spawn or the exit-wait throws (mirrors the try/catch scope rule from
    // apps/server/CLAUDE.md — `controller` block-scoping bit us once).
    let proc: ExecSubprocess
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | null = null

    try {
      proc = _execInternals.spawn(argv, { cwd: absCwd, stdout: 'pipe', stderr: 'pipe' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ argv, cwd: absCwd, err: msg }, 'run_command spawn failed')
      return `Error: spawn falló para ${argv[0]}: ${msg}`
    }

    try {
      timer = setTimeout(() => {
        timedOut = true
        try {
          proc.kill()
        } catch {
          // Process already exited between the timer firing and the kill;
          // exitCode will resolve on its own.
        }
      }, timeoutMs)

      const [stdout, stderr, exitCode] = await Promise.all([
        drainStream(proc.stdout),
        drainStream(proc.stderr),
        proc.exited,
      ])

      // stdout first, stderr appended with a separator so the agent can tell
      // the two apart even after truncation.
      const combinedRaw = stderr
        ? `${stdout}${stdout && !stdout.endsWith('\n') ? '\n' : ''}--- stderr ---\n${stderr}`
        : stdout
      const output = truncateOutput(combinedRaw)

      const header = timedOut
        ? `[timeout after ${timeoutMs}ms] exit ${exitCode}`
        : `exit ${exitCode}`

      log.info(
        {
          argv,
          exitCode,
          timedOut,
          outBytes: Buffer.byteLength(output, 'utf-8'),
          truncated: output.endsWith('[truncated]'),
        },
        'run_command done',
      )

      return `${header}\n${output}`
    } finally {
      if (timer) clearTimeout(timer)
    }
  },
})
