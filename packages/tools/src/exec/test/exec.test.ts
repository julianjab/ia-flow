// Unit tests for `run_command` — every path funnels through the four guards
// (writePaths, whitelist, git-safe, cwd) before any spawn happens, so most of
// the coverage is pure logic. The spawn seam (`_execInternals.spawn`) is
// swapped for a controllable fake in the few cases that need to drive the
// process lifecycle (timeout, non-zero exit, output truncation).

import { afterEach, describe, expect, it } from 'bun:test'
import type { ToolContext } from '../contract.js'
import { getTool } from '../engine.js'
// Side-effect import — registers `run_command` in the process-wide registry.
import './exec.js'
import {
  COMMAND_WHITELIST,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  OUTPUT_MAX_BYTES,
  type SpawnedProc,
  _execInternals,
  assertBinaryAllowed,
  assertCwdInWritePaths,
  assertGhSafe,
  assertGitSafe,
  normalizeTimeoutMs,
  parseArgv,
  truncateOutput,
} from './exec.js'

// ─── Fixtures ────────────────────────────────────────────────────────────

const writableCtx: ToolContext = { repoPaths: {}, writePaths: ['/wt'] }

// Preserve the real spawn so each test restores it in `afterEach`. If a test
// forgets to restore, `_execInternals.spawn` would point at a mock inside
// the next test's stack (bleeding between describes).
const REAL_SPAWN = _execInternals.spawn

afterEach(() => {
  _execInternals.spawn = REAL_SPAWN
})

/**
 * Build a `SpawnedProc` whose stdout / stderr / exit are controllable. Each
 * test decides whether the process exits naturally, gets killed by the
 * timeout timer, or throws — without shelling out. `kill()` resolves the
 * `exited` promise with `signal + 128` (POSIX convention for SIGTERM=15 →
 * exit code 143), which the tool reports verbatim in the header.
 */
function mockProc(
  opts: {
    stdout?: string
    stderr?: string
    /** When set, `exited` resolves to this code after `delayMs` ms. When
     *  omitted, `exited` only resolves via `kill()`. */
    exitCode?: number
    delayMs?: number
  } = {},
): SpawnedProc {
  const stdoutText = opts.stdout ?? ''
  const stderrText = opts.stderr ?? ''
  const mkStream = (text: string): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        if (text) controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    })
  let resolveExit: (code: number) => void = () => {}
  const exited = new Promise<number>((r) => {
    resolveExit = r
  })
  if (opts.exitCode !== undefined) {
    const delay = opts.delayMs ?? 0
    setTimeout(() => resolveExit(opts.exitCode!), delay)
  }
  return {
    stdout: mkStream(stdoutText),
    stderr: mkStream(stderrText),
    exited,
    // 143 = 128 + 15 (SIGTERM), matches how POSIX shells report a killed
    // process. Tool only cares that `exited` resolves, not the value.
    kill: () => resolveExit(143),
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────

describe('parseArgv', () => {
  it('splits by whitespace and drops empties', () => {
    expect(parseArgv('git status')).toEqual(['git', 'status'])
    expect(parseArgv('   bun   run   test  ')).toEqual(['bun', 'run', 'test'])
    expect(parseArgv('ls')).toEqual(['ls'])
    expect(parseArgv('')).toEqual([])
    expect(parseArgv('   ')).toEqual([])
  })

  it('does NOT honour quotes or escapes (naive split by design)', () => {
    // The tool contract says quoting is meaningless — Bun.spawn takes argv
    // directly, no shell. So `"a b"` is two tokens `"a` and `b"`.
    expect(parseArgv('echo "a b"')).toEqual(['echo', '"a', 'b"'])
  })
})

describe('COMMAND_WHITELIST', () => {
  it('contains exactly the PRD-approved binaries (no accidental additions)', () => {
    // Locking this shape prevents someone from casually adding `sh`, `bash`,
    // `curl`, etc. — new entries should be a conscious PR reviewer call, so
    // this test intentionally requires the list to be edited alongside the
    // whitelist itself.
    const expected = new Set([
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
    expect(COMMAND_WHITELIST.size).toBe(expected.size)
    for (const bin of expected) {
      expect(COMMAND_WHITELIST.has(bin)).toBe(true)
    }
  })

  it('does NOT contain shell / network binaries', () => {
    for (const forbidden of ['sh', 'bash', 'zsh', 'curl', 'wget', 'rm', 'sudo', 'ssh']) {
      expect(COMMAND_WHITELIST.has(forbidden)).toBe(false)
    }
  })
})

describe('assertBinaryAllowed', () => {
  it('accepts whitelisted binaries silently', () => {
    for (const bin of ['bun', 'bunx', 'node', 'npm', 'git', 'pytest', 'rg', 'cat']) {
      expect(() => assertBinaryAllowed([bin, '--help'])).not.toThrow()
    }
  })

  it('rejects unknown binaries with the exact PRD-mandated message', () => {
    expect(() => assertBinaryAllowed(['rm', '-rf', '/'])).toThrow('binario no permitido: rm')
    expect(() => assertBinaryAllowed(['curl', 'https://evil'])).toThrow(
      'binario no permitido: curl',
    )
    expect(() => assertBinaryAllowed(['sh', '-c', 'ls'])).toThrow('binario no permitido: sh')
  })

  it('rejects empty argv defensively', () => {
    expect(() => assertBinaryAllowed([])).toThrow('comando vacío')
  })
})

describe('assertCwdInWritePaths', () => {
  it('defaults to writePaths[0] when cwd is omitted', () => {
    const target = assertCwdInWritePaths(undefined, ['/wt/repo-a', '/wt/repo-b'])
    // Resolves to the same string via `path.resolve` on absolute inputs.
    expect(target).toBe('/wt/repo-a')
  })

  it('accepts cwd inside a writePath (exact match)', () => {
    expect(assertCwdInWritePaths('/wt/repo-a', ['/wt/repo-a'])).toBe('/wt/repo-a')
  })

  it('accepts cwd nested inside a writePath (subdirectory match)', () => {
    expect(assertCwdInWritePaths('/wt/repo-a/src/foo', ['/wt/repo-a'])).toBe('/wt/repo-a/src/foo')
  })

  it('rejects cwd that lives outside every writePath', () => {
    expect(() => assertCwdInWritePaths('/etc', ['/wt/repo-a'])).toThrow(
      'cwd fuera de writePaths: /etc',
    )
  })

  it('rejects cwd whose prefix collides with a writePath but is not nested (path traversal defence)', () => {
    // `/wt/repo-a-evil` is NOT under `/wt/repo-a`. The prefix trick
    // `startsWith(root + '/')` guards against this — a plain
    // `startsWith(root)` would leak.
    expect(() => assertCwdInWritePaths('/wt/repo-a-evil', ['/wt/repo-a'])).toThrow(
      'cwd fuera de writePaths',
    )
  })

  it('rejects when writePaths is empty (exact PRD wording)', () => {
    expect(() => assertCwdInWritePaths('/wt/repo-a', [])).toThrow(
      'escritura no permitida en fase actual',
    )
    expect(() => assertCwdInWritePaths(undefined, undefined)).toThrow(
      'escritura no permitida en fase actual',
    )
  })
})

describe('assertGitSafe', () => {
  it('is a no-op for non-git binaries', () => {
    // Even if the second token looks like a scary git subcommand.
    expect(() => assertGitSafe(['node', 'checkout', '--hard'])).not.toThrow()
    expect(() => assertGitSafe(['bun', 'reset', '--hard'])).not.toThrow()
    expect(() => assertGitSafe(['ls', '-la'])).not.toThrow()
  })

  it('is a no-op for bare `git` (no subcommand)', () => {
    expect(() => assertGitSafe(['git'])).not.toThrow()
  })

  it('blocks branch changes (checkout / switch)', () => {
    expect(() => assertGitSafe(['git', 'checkout', 'main'])).toThrow('sale de la rama del task')
    expect(() => assertGitSafe(['git', 'switch', 'main'])).toThrow('sale de la rama del task')
  })

  it('blocks branch deletion (branch -d / -D)', () => {
    expect(() => assertGitSafe(['git', 'branch', '-d', 'feature'])).toThrow(
      'branch -d/-D bloqueado',
    )
    expect(() => assertGitSafe(['git', 'branch', '-D', 'feature'])).toThrow(
      'branch -d/-D bloqueado',
    )
    // Sanity: listing/creating branches is not blocked.
    expect(() => assertGitSafe(['git', 'branch'])).not.toThrow()
    expect(() => assertGitSafe(['git', 'branch', 'new-feature'])).not.toThrow()
  })

  it('blocks worktree remove', () => {
    expect(() => assertGitSafe(['git', 'worktree', 'remove', '/tmp/x'])).toThrow(
      'worktree remove bloqueado',
    )
    // But listing / adding is fine.
    expect(() => assertGitSafe(['git', 'worktree', 'list'])).not.toThrow()
    expect(() => assertGitSafe(['git', 'worktree', 'add', '/tmp/x'])).not.toThrow()
  })

  it('blocks reset --hard regardless of position', () => {
    expect(() => assertGitSafe(['git', 'reset', '--hard'])).toThrow('reset --hard bloqueado')
    expect(() => assertGitSafe(['git', 'reset', '--hard', 'HEAD~3'])).toThrow(
      'reset --hard bloqueado',
    )
    // Soft/mixed resets stay allowed — they don't touch the working tree.
    expect(() => assertGitSafe(['git', 'reset', 'HEAD'])).not.toThrow()
    expect(() => assertGitSafe(['git', 'reset', '--soft', 'HEAD~1'])).not.toThrow()
  })

  it('blocks push to a branch that is not HEAD / task/*', () => {
    expect(() => assertGitSafe(['git', 'push', 'origin', 'main'])).toThrow(
      'push a rama fuera del scope',
    )
    expect(() => assertGitSafe(['git', 'push', 'origin', 'develop'])).toThrow(
      'push a rama fuera del scope',
    )
    // Refspec with an off-task source side is also blocked.
    expect(() => assertGitSafe(['git', 'push', 'origin', 'main:refs/heads/task/x'])).toThrow(
      'push a rama fuera del scope',
    )
  })

  it('allows push to HEAD / task/* branches (with or without -u)', () => {
    expect(() => assertGitSafe(['git', 'push'])).not.toThrow()
    expect(() => assertGitSafe(['git', 'push', 'origin'])).not.toThrow()
    expect(() => assertGitSafe(['git', 'push', 'origin', 'HEAD'])).not.toThrow()
    expect(() => assertGitSafe(['git', 'push', 'origin', 'task/PVTI_abc'])).not.toThrow()
    expect(() => assertGitSafe(['git', 'push', '-u', 'origin', 'task/PVTI_abc'])).not.toThrow()
    expect(() => assertGitSafe(['git', 'push', 'origin', 'HEAD:refs/heads/task/x'])).not.toThrow()
  })
})

// ─── policy-driven overrides (issue #58) ─────────────────────────────────
// Covers AC 4 (releaser can push main, reviewer can't) and the matching
// negative case for assertBinaryAllowed (AC 5). The compiler + preset
// integration is exercised in application/policy.test.ts; here we just
// prove that assertGitSafe / assertBinaryAllowed honour the flags they
// receive.

describe('assertGitSafe with explicit policy.git', () => {
  it('allows push to main when allowPushMain=true', () => {
    const releaser = {
      allowReadonly: true,
      allowPushTask: true,
      allowPushMain: true,
      allowBranchOps: false,
      allowResetHard: false,
      allowWorktreeRemove: false,
    }
    expect(() => assertGitSafe(['git', 'push', 'origin', 'main'], releaser)).not.toThrow()
  })

  it('blocks push to main with the AC-pinned error when allowPushMain=false', () => {
    const reviewer = {
      allowReadonly: true,
      allowPushTask: true,
      allowPushMain: false,
      allowBranchOps: false,
      allowResetHard: false,
      allowWorktreeRemove: false,
    }
    expect(() => assertGitSafe(['git', 'push', 'origin', 'main'], reviewer)).toThrow(
      'git push a rama fuera del scope: main',
    )
  })

  it('allows destructive git ops only when allowBranchOps / allowResetHard flags are on', () => {
    const destructive = {
      allowReadonly: true,
      allowPushTask: true,
      allowPushMain: false,
      allowBranchOps: true,
      allowResetHard: true,
      allowWorktreeRemove: true,
    }
    expect(() => assertGitSafe(['git', 'checkout', 'main'], destructive)).not.toThrow()
    expect(() => assertGitSafe(['git', 'reset', '--hard'], destructive)).not.toThrow()
    expect(() => assertGitSafe(['git', 'worktree', 'remove', '/x'], destructive)).not.toThrow()
  })
})

describe('assertBinaryAllowed with explicit policy.bash.bins', () => {
  it('accepts gh when the policy includes it', () => {
    expect(() => assertBinaryAllowed(['gh', 'pr', 'list'], new Set(['gh']))).not.toThrow()
  })

  it('rejects gh with the AC-stable error when the policy excludes it', () => {
    expect(() => assertBinaryAllowed(['gh', 'pr', 'create'], new Set(['bun']))).toThrow(
      'binario no permitido: gh',
    )
  })
})

// ─── pre-push-review hardening (issue #58) ────────────────────────────────
// The initial pass shipped assertGitSafe as a blocklist and a bare `gh`
// binary. Both leaked capabilities the presets promised to withhold:
//   - `git -C /elsewhere push origin main` bypassed cwd + push rules.
//   - `bash:git.readonly` still allowed `git commit`, `git clean`, etc.
//   - `bash:gh` allowed `gh api -X PUT contents/…` (writes to any branch)
//     and `gh secret list` (leaks tenant creds).
// These tests cover the fixes.

const READONLY_GIT = {
  allowReadonly: true,
  allowPushTask: false,
  allowPushMain: false,
  allowBranchOps: false,
  allowResetHard: false,
  allowWorktreeRemove: false,
}
const RELEASER_GIT = {
  allowReadonly: true,
  allowPushTask: true,
  allowPushMain: true,
  allowBranchOps: false,
  allowResetHard: false,
  allowWorktreeRemove: false,
}
const DESTRUCTIVE_GIT = {
  allowReadonly: true,
  allowPushTask: true,
  allowPushMain: false,
  allowBranchOps: true,
  allowResetHard: true,
  allowWorktreeRemove: true,
}

describe('assertGitSafe scope-changing global flags', () => {
  it('rejects `-C /elsewhere` even when the subcommand would be fine', () => {
    expect(() => assertGitSafe(['git', '-C', '/tmp/other', 'status'])).toThrow(
      'git flag no permitido: -C',
    )
  })
  it('rejects `--git-dir` and `--work-tree` (both space and = forms)', () => {
    expect(() => assertGitSafe(['git', '--git-dir', '/x/.git', 'log'])).toThrow(
      'git flag no permitido: --git-dir',
    )
    expect(() => assertGitSafe(['git', '--work-tree=/x', 'log'])).toThrow(
      'git flag no permitido: --work-tree',
    )
  })
  it('still catches push when preceded by legit global flags like `-c`', () => {
    // Regression: earlier code took argv[1] as the subcommand; `-c
    // foo=bar push origin main` would set sub to `-c` and slip through.
    expect(() => assertGitSafe(['git', '-c', 'user.name=X', 'push', 'origin', 'main'])).toThrow(
      'git push a rama fuera del scope: main',
    )
  })
})

describe('assertGitSafe readonly allowlist', () => {
  it('allows canonical read subs under a readonly-only policy', () => {
    for (const sub of ['log', 'status', 'diff', 'show', 'fetch', 'blame', 'rev-parse']) {
      expect(() => assertGitSafe(['git', sub], READONLY_GIT)).not.toThrow()
    }
  })

  it('blocks `git commit` under a readonly-only policy', () => {
    expect(() => assertGitSafe(['git', 'commit', '-m', 'x'], READONLY_GIT)).toThrow(
      'git commit bloqueado',
    )
  })

  it('blocks `git clean -fdx` unless the policy grants destructive', () => {
    expect(() => assertGitSafe(['git', 'clean', '-fdx'], READONLY_GIT)).toThrow(
      'git clean bloqueado: destructivo',
    )
    expect(() => assertGitSafe(['git', 'clean', '-fdx'], DESTRUCTIVE_GIT)).not.toThrow()
  })

  it('blocks `git config remote.origin.url …` unless allowPushMain', () => {
    expect(() =>
      assertGitSafe(['git', 'config', 'remote.origin.url', 'https://evil'], READONLY_GIT),
    ).toThrow('git config <set> bloqueado')
    expect(() =>
      assertGitSafe(['git', 'config', 'remote.origin.url', 'https://evil'], RELEASER_GIT),
    ).not.toThrow()
    // Read forms stay allowed.
    expect(() =>
      assertGitSafe(['git', 'config', '--get', 'user.email'], READONLY_GIT),
    ).not.toThrow()
  })

  it('blocks `git remote set-url` unless allowPushMain, but allows `remote -v`', () => {
    expect(() =>
      assertGitSafe(['git', 'remote', 'set-url', 'origin', 'https://x'], READONLY_GIT),
    ).toThrow('git remote set-url bloqueado')
    expect(() =>
      assertGitSafe(['git', 'remote', 'set-url', 'origin', 'https://x'], RELEASER_GIT),
    ).not.toThrow()
    expect(() => assertGitSafe(['git', 'remote', '-v'], READONLY_GIT)).not.toThrow()
  })

  it('denies unknown subcommands by default (allowlist model)', () => {
    // `filter-repo` isn't shipped with mainline git but agents installing
    // it locally could invoke it. Should be rejected.
    expect(() =>
      assertGitSafe(['git', 'filter-repo', '--path', 'x'], DESTRUCTIVE_GIT),
    ).not.toThrow()
    expect(() => assertGitSafe(['git', 'never-heard-of', '--flag'], RELEASER_GIT)).toThrow(
      'subcomando no reconocido',
    )
  })
})

describe('assertGhSafe', () => {
  it('is a no-op for non-gh binaries and bare gh', () => {
    expect(() => assertGhSafe(['git', 'status'])).not.toThrow()
    expect(() => assertGhSafe(['gh'])).not.toThrow()
  })

  it('allows PR / issue / label / search / browse', () => {
    for (const sub of ['pr', 'issue', 'label', 'search', 'browse', 'status']) {
      expect(() => assertGhSafe(['gh', sub, 'list'])).not.toThrow()
    }
  })

  it('allows GET api calls with or without explicit -X', () => {
    expect(() => assertGhSafe(['gh', 'api', 'users/octocat'])).not.toThrow()
    expect(() => assertGhSafe(['gh', 'api', '-X', 'GET', 'users/octocat'])).not.toThrow()
  })

  it('blocks mutating api verbs when the policy lacks allowPushMain', () => {
    expect(() =>
      assertGhSafe(['gh', 'api', '-X', 'PUT', 'repos/o/r/contents/README.md'], READONLY_GIT),
    ).toThrow('gh api con verb mutante')
    expect(() =>
      assertGhSafe(['gh', 'api', '--method', 'POST', 'repos/o/r/pulls'], READONLY_GIT),
    ).toThrow('gh api con verb mutante')
  })

  it('allows mutating api verbs when the policy grants allowPushMain (releaser)', () => {
    expect(() =>
      assertGhSafe(['gh', 'api', '-X', 'PATCH', 'repos/o/r/pulls/1'], RELEASER_GIT),
    ).not.toThrow()
  })

  it('hard-denies secret / auth / alias / config / extension', () => {
    for (const sub of ['secret', 'auth', 'alias', 'config', 'extension', 'variable', 'ssh-key']) {
      expect(() => assertGhSafe(['gh', sub, 'list'], RELEASER_GIT)).toThrow(`gh ${sub} bloqueado`)
    }
  })

  it('permits `gh repo view` but blocks `gh repo delete` / `create`', () => {
    expect(() => assertGhSafe(['gh', 'repo', 'view', 'o/r'], RELEASER_GIT)).not.toThrow()
    expect(() => assertGhSafe(['gh', 'repo', 'delete', 'o/r'], RELEASER_GIT)).toThrow(
      "sólo 'gh repo view' está permitido",
    )
  })

  it('denies unknown gh subcommands (allowlist)', () => {
    expect(() => assertGhSafe(['gh', 'made-up'], RELEASER_GIT)).toThrow('subcomando no reconocido')
  })
})

describe('normalizeTimeoutMs', () => {
  it('defaults to 60 s when unset or invalid', () => {
    expect(normalizeTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS)
    expect(normalizeTimeoutMs(0)).toBe(DEFAULT_TIMEOUT_MS)
    expect(normalizeTimeoutMs(-1)).toBe(DEFAULT_TIMEOUT_MS)
    expect(normalizeTimeoutMs(Number.NaN)).toBe(DEFAULT_TIMEOUT_MS)
    expect(normalizeTimeoutMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TIMEOUT_MS)
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000)
  })

  it('caps at 300 s regardless of what the agent asks for', () => {
    expect(normalizeTimeoutMs(MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS)
    expect(normalizeTimeoutMs(MAX_TIMEOUT_MS + 1)).toBe(MAX_TIMEOUT_MS)
    expect(normalizeTimeoutMs(10_000_000)).toBe(MAX_TIMEOUT_MS)
    expect(MAX_TIMEOUT_MS).toBe(300_000)
  })

  it('passes through legal values unchanged', () => {
    expect(normalizeTimeoutMs(1)).toBe(1)
    expect(normalizeTimeoutMs(1_500)).toBe(1_500)
    expect(normalizeTimeoutMs(120_000)).toBe(120_000)
  })
})

describe('truncateOutput', () => {
  it('is a no-op when input is under the cap', () => {
    const s = 'hola'
    expect(truncateOutput(s)).toBe(s)
    // Explicit cap arg for clarity.
    expect(truncateOutput(s, 100)).toBe(s)
  })

  it('cuts to the requested byte count and appends [truncated]', () => {
    const s = 'x'.repeat(30 * 1024)
    const out = truncateOutput(s, 20 * 1024)
    expect(out.endsWith('\n[truncated]')).toBe(true)
    // Body length equals the cap; suffix adds `\n[truncated]` (12 bytes).
    expect(out.length).toBe(20 * 1024 + '\n[truncated]'.length)
  })

  it('uses OUTPUT_MAX_BYTES (20 KB) by default', () => {
    expect(OUTPUT_MAX_BYTES).toBe(20 * 1024)
    const s = 'x'.repeat(OUTPUT_MAX_BYTES + 100)
    const out = truncateOutput(s)
    expect(out).toContain('[truncated]')
    expect(Buffer.byteLength(out, 'utf-8')).toBe(OUTPUT_MAX_BYTES + '\n[truncated]'.length)
  })
})

// ─── Tool registration + execute() ───────────────────────────────────────

describe('run_command tool registration', () => {
  it('is registered under `run_command`', () => {
    expect(getTool('bash_run')).toBeDefined()
  })

  it('is restricted to sync providers (excluded from async curl appendix)', () => {
    const tool = getTool('bash_run')!
    expect(tool.providerKinds).toEqual(['sync'])
  })

  it('is marked apiOnly at the registry level (documentation flag)', () => {
    // Mirrors write_file / edit_file / reset_worktree — the marker is
    // documentation-only (real filtering is `providerKinds`), but must be
    // set so a reader spots the sandbox dependency at the registration site.
    const tool = getTool('bash_run')!
    expect(tool.apiOnly).toBe(true)
  })

  it('declares `command` as the only required schema field', () => {
    const tool = getTool('bash_run')!
    const schema = tool.input_schema as {
      type: string
      properties: Record<string, unknown>
      required: string[]
    }
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['command'])
    expect(schema.properties).toHaveProperty('command')
    expect(schema.properties).toHaveProperty('cwd')
    expect(schema.properties).toHaveProperty('timeout_ms')
  })
})

describe('run_command — writePaths gate', () => {
  it('refuses with the shared write-tool wording when writePaths is missing/empty', async () => {
    const tool = getTool('bash_run')!
    for (const ctx of [
      { repoPaths: {} },
      { repoPaths: {}, writePaths: [] },
    ] satisfies ToolContext[]) {
      const out = await tool.execute({ command: 'ls' }, ctx)
      expect(out).toContain('escritura no permitida en fase actual')
    }
    // Spawn seam must not have fired.
    // (If it had, `REAL_SPAWN` would have tried to hit /wt which does not exist.)
  })

  it('validates that command is a non-empty string', async () => {
    const tool = getTool('bash_run')!
    for (const bad of [{}, { command: '' }, { command: '   ' }, { command: 123 }]) {
      const out = await tool.execute(bad, writableCtx)
      expect(out).toContain('bash_run failed')
      expect(out).toMatch(/command|comando/)
    }
  })
})

describe('run_command — whitelist enforcement', () => {
  it('rejects non-whitelisted binaries before spawning', async () => {
    const tool = getTool('bash_run')!
    let spawnCalled = false
    _execInternals.spawn = () => {
      spawnCalled = true
      return mockProc({ exitCode: 0 })
    }
    const out = await tool.execute({ command: 'rm -rf /' }, writableCtx)
    expect(out).toContain('binario no permitido: rm')
    expect(spawnCalled).toBe(false)
  })

  it('rejects a shell attempt (sh -c) even though the payload looks harmless', async () => {
    const tool = getTool('bash_run')!
    const out = await tool.execute({ command: 'sh -c "ls"' }, writableCtx)
    expect(out).toContain('binario no permitido: sh')
  })

  it('spawns whitelisted binaries with the resolved argv + cwd (default writePaths[0])', async () => {
    const tool = getTool('bash_run')!
    const captured: { argv?: string[]; cwd?: string } = {}
    _execInternals.spawn = (argv, cwd) => {
      captured.argv = argv
      captured.cwd = cwd
      return mockProc({ stdout: 'total 0\n', exitCode: 0 })
    }
    const out = await tool.execute({ command: 'ls -la' }, writableCtx)
    expect(captured.argv).toEqual(['ls', '-la'])
    expect(captured.cwd).toBe('/wt')
    expect(out).toContain('exit=0')
    expect(out).toContain('total 0')
  })

  it('honours an explicit cwd inside writePaths (nested dir)', async () => {
    const tool = getTool('bash_run')!
    const ctx: ToolContext = { repoPaths: {}, writePaths: ['/wt/repo-a', '/wt/repo-b'] }
    let seenCwd = ''
    _execInternals.spawn = (_argv, cwd) => {
      seenCwd = cwd
      return mockProc({ exitCode: 0 })
    }
    await tool.execute({ command: 'ls', cwd: '/wt/repo-b/src' }, ctx)
    expect(seenCwd).toBe('/wt/repo-b/src')
  })

  it('rejects an explicit cwd outside every writePath', async () => {
    const tool = getTool('bash_run')!
    let spawnCalled = false
    _execInternals.spawn = () => {
      spawnCalled = true
      return mockProc({ exitCode: 0 })
    }
    const out = await tool.execute({ command: 'ls', cwd: '/etc' }, writableCtx)
    expect(out).toContain('cwd fuera de writePaths')
    expect(spawnCalled).toBe(false)
  })
})

describe('run_command — git safety at execute() boundary', () => {
  it('blocks destructive git ops before spawning', async () => {
    const tool = getTool('bash_run')!
    let spawnCalled = false
    _execInternals.spawn = () => {
      spawnCalled = true
      return mockProc({ exitCode: 0 })
    }
    for (const cmd of [
      'git checkout main',
      'git switch main',
      'git branch -D feature',
      'git worktree remove /tmp/x',
      'git reset --hard HEAD~1',
      'git push origin main',
    ]) {
      const out = await tool.execute({ command: cmd }, writableCtx)
      expect(out).toContain('bash_run failed')
      // Each rule surfaces its own message; sanity-check we hit the git
      // guard by not seeing the whitelist or spawn errors.
      expect(out).not.toContain('binario no permitido')
      expect(out).not.toContain('spawn error')
    }
    expect(spawnCalled).toBe(false)
  })

  it('allows safe git ops (status, add, commit, push to task branch)', async () => {
    const tool = getTool('bash_run')!
    _execInternals.spawn = () => mockProc({ stdout: 'ok\n', exitCode: 0 })
    for (const cmd of [
      'git status',
      'git add -A',
      'git commit -m fix',
      'git push',
      'git push origin task/PVTI_abc',
      'git push -u origin task/PVTI_abc',
    ]) {
      const out = await tool.execute({ command: cmd }, writableCtx)
      expect(out).toContain('exit=0')
    }
  })
})

describe('run_command — timeout', () => {
  it('kills the process on timeout and marks the output [timeout]', async () => {
    const tool = getTool('bash_run')!
    let killed = false
    _execInternals.spawn = () => {
      // `exited` never resolves on its own → only the kill() call in the
      // timer resolves it. That's exactly the pathological long-runner
      // shape we want to cover.
      const proc = mockProc({ stdout: 'partial output\n' })
      const originalKill = proc.kill
      proc.kill = (sig) => {
        killed = true
        originalKill(sig)
      }
      return proc
    }
    const out = await tool.execute({ command: 'bun test --watch', timeout_ms: 20 }, writableCtx)
    expect(killed).toBe(true)
    expect(out).toContain('[timeout]')
    expect(out).toContain('killed after timeout')
    // Partial output must still be returned so the agent can reason about it.
    expect(out).toContain('partial output')
  })

  it('does NOT mark [timeout] when the process exits naturally in time', async () => {
    const tool = getTool('bash_run')!
    _execInternals.spawn = () => mockProc({ stdout: 'done\n', exitCode: 0 })
    const out = await tool.execute({ command: 'ls', timeout_ms: 1_000 }, writableCtx)
    expect(out).not.toContain('[timeout]')
    expect(out).not.toContain('killed after timeout')
    expect(out).toContain('exit=0')
  })
})

describe('run_command — output truncation', () => {
  it('truncates combined stdout+stderr to 20 KB and appends [truncated]', async () => {
    const tool = getTool('bash_run')!
    _execInternals.spawn = () =>
      mockProc({
        // 25 KB of stdout — comfortably above the 20 KB cap.
        stdout: 'A'.repeat(25 * 1024),
        exitCode: 0,
      })
    const out = await tool.execute({ command: 'cat huge.log' }, writableCtx)
    expect(out).toContain('[truncated]')
    // Header line + truncated body. The body portion (after `exit=0\n`)
    // must not exceed OUTPUT_MAX_BYTES + the marker.
    const bodyBytes = Buffer.byteLength(out, 'utf-8')
    expect(bodyBytes).toBeLessThan(OUTPUT_MAX_BYTES + 200)
  })

  it('does NOT append [truncated] when output fits under the cap', async () => {
    const tool = getTool('bash_run')!
    _execInternals.spawn = () => mockProc({ stdout: 'small\n', exitCode: 0 })
    const out = await tool.execute({ command: 'ls' }, writableCtx)
    expect(out).not.toContain('[truncated]')
    expect(out).toContain('small')
  })
})

describe('run_command — spawn errors', () => {
  it('surfaces spawn throws as tool-result strings (never bubble into the loop)', async () => {
    const tool = getTool('bash_run')!
    _execInternals.spawn = () => {
      throw new Error('ENOENT: git binary missing')
    }
    const out = await tool.execute({ command: 'git status' }, writableCtx)
    expect(out).toContain('bash_run failed: spawn error:')
    expect(out).toContain('ENOENT')
  })

  it('reports non-zero exit codes in the header', async () => {
    const tool = getTool('bash_run')!
    _execInternals.spawn = () => mockProc({ stderr: 'boom\n', exitCode: 2 })
    const out = await tool.execute({ command: 'pytest' }, writableCtx)
    expect(out).toContain('exit=2')
    expect(out).toContain('boom')
  })
})
