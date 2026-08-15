// `run_command` — sandboxed shell-less command execution for the anthropic-api
// provider. Everything in this file funnels through four guards before spawn:
//
//   1. writePaths present (mirrors write_file / edit_file — no writable
//      zone means the run is read-only and exec is meaningless).
//   2. Binary in the policy's bin whitelist (`ctx.policy.bash.bins`, falling
//      back to `LEGACY_DEFAULT_POLICY.bash.bins`).
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
import type { CompiledPolicy, ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'
import { createLogger } from '../logger.js'
import { LEGACY_DEFAULT_POLICY } from '../policy.js'

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
 * redirection, glob expansion) it must chain multiple `run_command`
 * invocations.
 */
export function parseArgv(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean)
}

/** Throws `binario no permitido: <cmd>` when `argv[0]` isn't in the
 *  policy's bin whitelist. Empty argv → `comando vacío` (defensive;
 *  callers should short-circuit earlier). When `bins` is omitted, falls
 *  back to the legacy whitelist for backwards compatibility. */
export function assertBinaryAllowed(argv: string[], bins?: ReadonlySet<string>): void {
  const bin = argv[0]
  if (!bin) throw new Error('comando vacío')
  const allow = bins ?? LEGACY_DEFAULT_POLICY.bash.bins
  if (!allow.has(bin)) {
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

// ─── git sub-command classification (allowlist model) ──────────────────
// Post pre-push-review fix: the readonly baseline is an ALLOWLIST, not a
// blocklist. When policy only grants `allowReadonly`, any subcommand not in
// GIT_READONLY_SUBS is rejected. That closes the gap where `git commit`,
// `git clean -fdx`, `git config remote.origin.url …` all used to slip
// through under `bash:git.readonly`.

const GIT_READONLY_SUBS: ReadonlySet<string> = new Set([
  'log',
  'status',
  'diff',
  'show',
  'fetch',
  'ls-files',
  'ls-tree',
  'ls-remote',
  'rev-parse',
  'rev-list',
  'blame',
  'describe',
  'cat-file',
  'shortlog',
  'name-rev',
  'grep',
  'reflog',
  'stash', // list-only path; push/pop gated as write below
  'tag', // read-only when no -d/-a/-s/-f — write forms fall to GIT_WRITE_SUBS via `tag`
  'branch', // read-only when no -d/-D — handled explicitly below
  'worktree', // read-only when subcommand is `list` — handled below
  'remote', // read forms handled explicitly below
  'config', // read forms handled explicitly below
])

const GIT_WRITE_SUBS: ReadonlySet<string> = new Set([
  'add',
  'commit',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'am',
  'apply',
  'mv',
  'restore',
  // `reset` (without `--hard`) still moves HEAD / the index; a readonly
  // agent has no business doing that. `reset --hard` is handled earlier
  // by its own destructive branch via `allowResetHard`.
  'reset',
])

const GIT_DESTRUCTIVE_SUBS: ReadonlySet<string> = new Set([
  'clean',
  'rm',
  'gc',
  'prune',
  'filter-branch',
  'filter-repo',
])

/**
 * Reject global git flags that redirect scope away from the sandbox — `-C
 * /elsewhere`, `--git-dir=…`, `--work-tree=…`. All three defeat
 * `assertCwdInWritePaths` and every path-relative rule in this file, so
 * they are always rejected regardless of policy.
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
 * Skip past git's global flags (`-c key=val`, `-p`, `--paginate`, …) and
 * return the actual subcommand token PLUS its index in argv. `-c` takes a
 * following argument so we can't naively skip only `-*`. Returns
 * `undefined` for bare `git`. The index is used by push/config/remote
 * branches so they slice from the right offset instead of the hard-coded
 * `argv.slice(2)` (which would treat `-c foo=bar` positionals as refspecs).
 */
function extractGitSub(argv: string[]): { sub: string; index: number } | undefined {
  let i = 1
  while (i < argv.length) {
    const a = argv[i]
    if (!a.startsWith('-')) return { sub: a, index: i }
    if (a === '-c') {
      i += 2
      continue
    }
    i++
  }
  return undefined
}

/**
 * True when the `config` invocation is a pure read (`--get`, `--list`,
 * `--get-all`, `--get-regexp`, `--show-origin`, or `-l`). Anything else
 * (set, unset, add, --edit) mutates persisted config. Receives the tokens
 * AFTER the `config` sub-command (i.e. `subArgs` in the caller).
 */
function isConfigReadOnly(subArgs: string[]): boolean {
  const readFlags = new Set(['--get', '--list', '-l', '--get-all', '--get-regexp', '--show-origin'])
  return subArgs.some((f) => readFlags.has(f)) && !subArgs.includes('--edit')
}

/**
 * Reject destructive git subcommands or ones the current policy doesn't
 * allow. No-op for non-`git` argv. All rules run *before* spawn — parity
 * with the whitelist and writePaths guards.
 *
 * The `git` rules are data now (not conditionals): every branch reads a
 * flag off `policy.git` (see `CompiledPolicy` in application/policy.ts).
 * When `git` is omitted, falls back to the legacy default (readonly + task
 * push, everything else blocked) so callers without a compiled policy keep
 * pre-issue-58 behavior.
 *
 * Error strings are stable — operators grep for them, and issue #58 AC 4/5
 * pin two of them explicitly.
 */
export function assertGitSafe(argv: string[], git?: CompiledPolicy['bash']['git']): void {
  if (argv[0] !== 'git') return
  assertNoScopeChangingGitFlags(argv)
  const extracted = extractGitSub(argv)
  if (!extracted) return
  const { sub, index: subIdx } = extracted
  // Arguments strictly AFTER the subcommand token — used by push/config/
  // remote so `-c foo=bar` global-flag operands don't get misread as
  // sub-arguments.
  const subArgs = argv.slice(subIdx + 1)

  const rules = git ?? LEGACY_DEFAULT_POLICY.bash.git

  if (GIT_DESTRUCTIVE_SUBS.has(sub)) {
    if (rules.allowResetHard) return
    throw new Error(`git ${sub} bloqueado: destructivo (requiere bash:git.destructive)`)
  }

  if (sub === 'checkout' || sub === 'switch') {
    if (rules.allowBranchOps) return
    throw new Error(`git ${sub} bloqueado: sale de la rama del task`)
  }

  if (sub === 'branch' && (subArgs.includes('-d') || subArgs.includes('-D'))) {
    if (rules.allowBranchOps) return
    throw new Error('git branch -d/-D bloqueado: borrar ramas es destructivo')
  }

  if (sub === 'worktree' && subArgs[0] === 'remove') {
    if (rules.allowWorktreeRemove) return
    throw new Error('git worktree remove bloqueado: destruye el sandbox del task')
  }

  if (sub === 'reset' && subArgs.includes('--hard')) {
    if (rules.allowResetHard) return
    throw new Error('git reset --hard bloqueado: destruye el estado del worktree')
  }

  // `remote` / `config` — split by read vs mutate. Mutating either requires
  // main-push (they can redirect where pushes land or expose credentials).
  if (sub === 'remote') {
    const remoteSub = subArgs[0]
    const READONLY_REMOTE = new Set([undefined, '-v', '--verbose', 'show', 'get-url'])
    if (READONLY_REMOTE.has(remoteSub)) {
      if (rules.allowReadonly || rules.allowPushTask || rules.allowPushMain) return
      throw new Error('git remote bloqueado: sin permiso de lectura (bash:git.readonly)')
    }
    if (!rules.allowPushMain) {
      throw new Error(
        `git remote ${remoteSub} bloqueado: modifica remotes (requiere bash:git.write.main)`,
      )
    }
    return
  }
  if (sub === 'config') {
    if (isConfigReadOnly(subArgs)) {
      if (rules.allowReadonly || rules.allowPushTask || rules.allowPushMain) return
      throw new Error('git config bloqueado: sin permiso de lectura (bash:git.readonly)')
    }
    if (!rules.allowPushMain) {
      throw new Error(
        'git config <set> bloqueado: modifica configuración persistida (requiere bash:git.write.main)',
      )
    }
    return
  }

  if (sub === 'push') {
    // Extract the target refspec (positional after `git push [-flags]
    // <remote> <refspec>`). No refspec ⇒ the remote's default branch, which
    // we can't know statically; treat it as "task push" (permissive default
    // matches legacy behavior). AC #4 pins the exact error for the main
    // branch case.
    if (rules.allowPushMain) return
    const positionals = subArgs.filter((a) => !a.startsWith('-'))
    const refspec = positionals[1]
    if (!refspec) {
      if (!rules.allowPushTask) throw new Error('git push bloqueado: sin permiso de push')
      return
    }
    const src = refspec.includes(':') ? refspec.split(':')[0] : refspec
    const dst = refspec.includes(':') ? refspec.split(':')[1] : ''
    const isTaskRef = (r: string) =>
      r === 'HEAD' ||
      r.startsWith('task/') ||
      r === '' ||
      r.startsWith('refs/heads/task/') ||
      r === 'refs/heads/HEAD'
    const wantsTask = isTaskRef(src) && (!dst || isTaskRef(dst))
    if (wantsTask) {
      if (rules.allowPushTask) return
      throw new Error('git push bloqueado: sin permiso de push a task branch')
    }
    // Refspec targets something other than HEAD / task/*. That's a push to
    // main / release / arbitrary. Use the AC-pinned message when the target
    // resolves to `main` for grep-stability, else the general fuera-del-scope
    // form.
    const targetBranch = dst ? dst.replace(/^refs\/heads\//, '') : src
    throw new Error(`git push a rama fuera del scope: ${targetBranch}`)
  }

  // Write-tier subs (commit / add / merge / rebase / apply / …) — require
  // at least task-push. A readonly agent has no business committing.
  if (GIT_WRITE_SUBS.has(sub)) {
    if (rules.allowPushTask || rules.allowPushMain) return
    throw new Error(
      `git ${sub} bloqueado: modifica el repo (requiere bash:git.write.task o superior)`,
    )
  }

  // Readonly allowlist — the baseline for `bash:git.readonly`. Also
  // reachable by higher scopes (task/main push) since they subsume read.
  if (GIT_READONLY_SUBS.has(sub)) {
    if (rules.allowReadonly || rules.allowPushTask || rules.allowPushMain) return
    throw new Error(`git ${sub} bloqueado: sin permiso de lectura (bash:git.readonly)`)
  }

  // Fallback: unknown subcommand → deny by default. Better a surprised
  // "why is this blocked" than a silent `git filter-repo` shipping to prod.
  throw new Error(`git ${sub} bloqueado: subcomando no reconocido por el sandbox`)
}

// ─── gh sandbox (issue #58 pre-push-review fix #4) ───────────────────────
// `bash:gh` used to hand the agent a raw `gh` binary. That contradicts the
// `reviewer` preset's "never push directly to main" contract: `gh api -X
// PUT repos/:o/:r/contents/…` writes to any branch, `gh secret list`
// leaks tenant secrets, `gh repo delete` is nuclear. We narrow it here to
// PR/issue flows + read-only API access. Escalation (write-y API verbs)
// requires `allowPushMain` — parity with `git config <set>`.

const GH_ALLOWED_SUBS: ReadonlySet<string> = new Set([
  'pr', // create / merge / comment / view / list / checkout — all PR-scoped
  'issue', // create / close / comment / view / list
  'label', // read + label ops on PRs/issues
  'search',
  'browse',
  'status',
  'gist', // read-only forms below still gated for now — assume `pr`/`issue` covers most needs
])

const GH_READONLY_SUBS: ReadonlySet<string> = new Set([
  'api', // gated per-verb below
  'run', // `run list` / `run view` — read-only; `run rerun`/`cancel` are handled by verb check below
  'workflow', // read-only forms (`list`, `view`)
  'release', // read-only forms (`list`, `view`, `download`)
  'repo', // ONLY `view` — everything else falls through to the deny path
])

const GH_DENY_SUBS: ReadonlySet<string> = new Set([
  'secret',
  'variable',
  'ssh-key',
  'gpg-key',
  'auth', // exposes tokens
  'alias', // shell-escape via aliases
  'config', // gh config — could redirect the host or scope
  'codespace',
  'extension', // installing arbitrary extensions is exec-escape
])

/**
 * `gh api -X <VERB> …` — GET/HEAD are read-only. Anything else mutates
 * remote state (PR merges via API, contents writes, etc.).
 */
function ghApiIsWriteVerb(argv: string[]): boolean {
  // Look for `-X <VERB>` or `--method <VERB>` or `--method=<VERB>`.
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-X' || a === '--method') {
      const verb = (argv[i + 1] ?? '').toUpperCase()
      return verb !== '' && verb !== 'GET' && verb !== 'HEAD'
    }
    if (a.startsWith('--method=')) {
      const verb = a.split('=')[1]?.toUpperCase() ?? ''
      return verb !== 'GET' && verb !== 'HEAD'
    }
  }
  return false
}

/**
 * Sandbox rules for the `gh` CLI. No-op for non-`gh` argv. Called from the
 * `bash_run` guard chain right after `assertBinaryAllowed` when the
 * whitelist actually contains `gh` (i.e. the policy granted `bash:gh`).
 *
 * Rules:
 *   - `pr`, `issue`, `label`, `search`, `browse`, `status`, `gist` → allowed.
 *   - `api` → allowed for GET/HEAD; mutating verbs (`-X PUT/POST/PATCH/
 *     DELETE`) require `allowPushMain` (they can write to any branch).
 *   - `run`, `workflow`, `release`, `repo view` → allowed (read-only).
 *   - `secret`, `variable`, `ssh-key`, `gpg-key`, `auth`, `alias`, `config`,
 *     `codespace`, `extension` → hard deny (credential / exec-escape risks).
 *   - Anything else → deny (allowlist model, mirroring assertGitSafe).
 */
export function assertGhSafe(argv: string[], git?: CompiledPolicy['bash']['git']): void {
  if (argv[0] !== 'gh') return
  const sub = argv[1]
  if (!sub) return

  const rules = git ?? LEGACY_DEFAULT_POLICY.bash.git

  if (GH_DENY_SUBS.has(sub)) {
    throw new Error(`gh ${sub} bloqueado: fuera del scope del sandbox (credenciales / exec-escape)`)
  }

  if (GH_ALLOWED_SUBS.has(sub)) return

  if (sub === 'api') {
    if (!ghApiIsWriteVerb(argv)) return
    if (!rules.allowPushMain) {
      throw new Error(
        'gh api con verb mutante (PUT/POST/PATCH/DELETE) bloqueado: requiere bash:git.write.main',
      )
    }
    return
  }

  if (sub === 'repo') {
    // Only `repo view` is safe — the rest (create/delete/edit/fork/clone
    // outside the writePaths sandbox) needs deliberate approval.
    if (argv[2] === 'view') return
    throw new Error(`gh repo ${argv[2] ?? ''} bloqueado: sólo 'gh repo view' está permitido`)
  }

  if (GH_READONLY_SUBS.has(sub)) return

  throw new Error(`gh ${sub} bloqueado: subcomando no reconocido por el sandbox`)
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
  category: 'bash',
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
    `El primer token debe estar en la whitelist: ${[...LEGACY_DEFAULT_POLICY.bash.bins].join(', ')}.`,
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
      return 'bash_run failed: escritura no permitida en fase actual'
    }

    if (typeof input.command !== 'string' || input.command.trim().length === 0) {
      return 'bash_run failed: command es requerido y debe ser un string no vacío'
    }

    const argv = parseArgv(input.command)
    if (argv.length === 0) {
      return 'bash_run failed: comando vacío'
    }

    // Guards 2–4: whitelist, git safety, cwd scope. Any throw becomes a
    // stable `bash_run failed: <reason>` string so the agent can react
    // without a try/catch. Whitelist + git rules come from the compiled
    // policy on the context; when it's absent (legacy dispatch path with
    // no permissions[]), the helpers fall back to LEGACY_DEFAULT_POLICY so
    // pre-issue-58 agents keep working unchanged.
    const policy = ctx.policy
    const bins = policy?.bash.bins
    const git = policy?.bash.git
    let cwd: string
    try {
      assertBinaryAllowed(argv, bins)
      assertGitSafe(argv, git)
      assertGhSafe(argv, git)
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
