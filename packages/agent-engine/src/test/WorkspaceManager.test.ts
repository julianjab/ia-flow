import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_WORKTREE_BASE,
  type ShellResult,
  type ShellRunner,
  WorkspaceManager,
  branchNameFor,
  hasWriteTools,
  worktreePathFor,
} from '../WorkspaceManager.js'

// ─── Test doubles ────────────────────────────────────────────────────────

type Handler = (args: string[], cwd: string) => ShellResult | Promise<ShellResult>

function ok(stdout = ''): ShellResult {
  return { stdout, stderr: '', exitCode: 0 }
}
function fail(stderr = 'boom', exitCode = 1): ShellResult {
  return { stdout: '', stderr, exitCode }
}
function starts(args: string[], prefix: string[]): boolean {
  if (args.length < prefix.length) return false
  return prefix.every((p, i) => args[i] === p)
}
function exact(args: string[], expected: string[]): boolean {
  return args.length === expected.length && expected.every((p, i) => args[i] === p)
}

class StubShell implements ShellRunner {
  calls: Array<{ args: string[]; cwd: string }> = []
  constructor(private handler: Handler) {}
  async run(args: string[], cwd: string): Promise<ShellResult> {
    this.calls.push({ args: [...args], cwd })
    return this.handler(args, cwd)
  }
  ran(prefix: string[]): boolean {
    return this.calls.some((c) => starts(c.args, prefix))
  }
  find(prefix: string[]): { args: string[]; cwd: string } | undefined {
    return this.calls.find((c) => starts(c.args, prefix))
  }
}

const BASE = '/tmp/ia-flow-test'
const REPO = '/repos/demo'
const TASK = 'PVTI_lAHOtest001'
const WT = worktreePathFor(REPO, TASK, BASE) // /tmp/ia-flow-test/demo/.worktrees/<task>
const BR = branchNameFor(TASK) // task/<task>

// ─── Pure helpers ────────────────────────────────────────────────────────

describe('helpers', () => {
  it('worktreePathFor composes <base>/<repo>/.worktrees/<taskId>', () => {
    expect(worktreePathFor('/x/foo', 't1', '/tmp/ia-flow')).toBe('/tmp/ia-flow/foo/.worktrees/t1')
  })

  it('branchNameFor prefixes with task/', () => {
    expect(branchNameFor('abc')).toBe('task/abc')
  })

  it('DEFAULT_WORKTREE_BASE is under /tmp/ia-flow (no ~/.config/ia-flow)', () => {
    expect(DEFAULT_WORKTREE_BASE).toBe('/tmp/ia-flow')
  })

  it('hasWriteTools recognises write_file / edit_file / run_command', () => {
    expect(hasWriteTools({ tools: ['read_file'] })).toBe(false)
    expect(hasWriteTools({ tools: ['write_file'] })).toBe(true)
    expect(hasWriteTools({ tools: ['edit_file'] })).toBe(true)
    expect(hasWriteTools({ tools: ['run_command'] })).toBe(true)
    expect(hasWriteTools({})).toBe(false)
  })
})

// ─── getOrCreateWorktree ────────────────────────────────────────────────

describe('getOrCreateWorktree — create path', () => {
  it('fetches origin, sees no existing worktree/branch and creates from origin/main', async () => {
    const shell = new StubShell(async (args) => {
      if (exact(args, ['git', 'fetch', 'origin'])) return ok()
      if (exact(args, ['git', 'worktree', 'list', '--porcelain'])) {
        // Only the main worktree exists.
        return ok(`worktree ${REPO}\nHEAD abc\nbranch refs/heads/main\n`)
      }
      if (starts(args, ['git', 'rev-parse', '--verify'])) return fail('missing', 1)
      if (starts(args, ['git', 'worktree', 'add'])) return ok()
      throw new Error(`unexpected call: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: BASE })

    const path = await mgr.getOrCreateWorktree(TASK, REPO)

    expect(path).toBe(WT)
    expect(shell.ran(['git', 'fetch', 'origin'])).toBe(true)
    const add = shell.find(['git', 'worktree', 'add'])
    expect(add?.args).toEqual(['git', 'worktree', 'add', '-b', BR, WT, 'origin/main'])
    // No reuse-side ops leaked.
    expect(shell.ran(['git', 'status'])).toBe(false)
    expect(shell.ran(['git', 'merge'])).toBe(false)
  })

  it('reattaches to existing branch when worktree is gone (edge case)', async () => {
    const shell = new StubShell(async (args) => {
      if (exact(args, ['git', 'fetch', 'origin'])) return ok()
      if (exact(args, ['git', 'worktree', 'list', '--porcelain'])) {
        return ok(`worktree ${REPO}\n`) // only main
      }
      if (starts(args, ['git', 'rev-parse', '--verify'])) return ok() // branch exists
      if (starts(args, ['git', 'worktree', 'add'])) return ok()
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: BASE })
    await mgr.getOrCreateWorktree(TASK, REPO)

    const add = shell.find(['git', 'worktree', 'add'])
    // Reattaches — no `-b`, no `origin/main`, just <path> <branch>.
    expect(add?.args).toEqual(['git', 'worktree', 'add', WT, BR])
  })
})

describe('getOrCreateWorktree — reuse paths', () => {
  it('clean tree + fast-forwardable → applies ff, no autosalvage', async () => {
    const shell = new StubShell(async (args) => {
      if (exact(args, ['git', 'fetch', 'origin'])) return ok()
      if (exact(args, ['git', 'worktree', 'list', '--porcelain'])) {
        return ok(`worktree ${REPO}\n\nworktree ${WT}\nbranch refs/heads/${BR}\n`)
      }
      if (exact(args, ['git', 'status', '--porcelain'])) return ok('') // clean
      if (starts(args, ['git', 'merge-base', '--is-ancestor'])) return ok() // FF ok
      if (exact(args, ['git', 'merge', '--ff-only', 'origin/main'])) return ok()
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: BASE })

    await mgr.getOrCreateWorktree(TASK, REPO)

    expect(shell.ran(['git', 'add', '-A'])).toBe(false)
    expect(shell.ran(['git', 'commit'])).toBe(false)
    expect(shell.ran(['git', 'merge', '--ff-only', 'origin/main'])).toBe(true)
    // No create — worktree existed.
    expect(shell.ran(['git', 'worktree', 'add'])).toBe(false)
  })

  it('dirty tree → autosalvage commit tagged with prevRunId, then ff', async () => {
    const shell = new StubShell(async (args) => {
      if (exact(args, ['git', 'fetch', 'origin'])) return ok()
      if (exact(args, ['git', 'worktree', 'list', '--porcelain'])) {
        return ok(`worktree ${REPO}\n\nworktree ${WT}\n`)
      }
      if (exact(args, ['git', 'status', '--porcelain'])) return ok(' M foo.ts\n')
      if (exact(args, ['git', 'add', '-A'])) return ok()
      if (starts(args, ['git', 'commit'])) return ok()
      if (starts(args, ['git', 'merge-base', '--is-ancestor'])) return ok()
      if (exact(args, ['git', 'merge', '--ff-only', 'origin/main'])) return ok()
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: BASE })

    await mgr.getOrCreateWorktree(TASK, REPO, { prevRunId: 'run-42' })

    const commit = shell.find(['git', 'commit'])
    expect(commit).toBeDefined()
    // -m must carry the exact autosalvage phrase with the prevRunId echo'd back.
    const msgIdx = (commit?.args ?? []).indexOf('-m')
    expect(msgIdx).toBeGreaterThan(-1)
    expect(commit?.args[msgIdx + 1]).toBe('WIP autosalvage from run run-42')
    expect(shell.ran(['git', 'add', '-A'])).toBe(true)
  })

  it('uses recorded runId when prevRunId is not passed explicitly', async () => {
    const shell = new StubShell(async (args) => {
      if (exact(args, ['git', 'fetch', 'origin'])) return ok()
      if (exact(args, ['git', 'worktree', 'list', '--porcelain'])) {
        return ok(`worktree ${REPO}\n\nworktree ${WT}\n`)
      }
      if (exact(args, ['git', 'status', '--porcelain'])) return ok(' M foo.ts\n')
      if (exact(args, ['git', 'add', '-A'])) return ok()
      if (starts(args, ['git', 'commit'])) return ok()
      if (starts(args, ['git', 'merge-base', '--is-ancestor'])) return fail('diverged', 1)
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: BASE })
    mgr.recordRunId(TASK, 'run-prev-99')

    await mgr.getOrCreateWorktree(TASK, REPO)

    const commit = shell.find(['git', 'commit'])
    const msgIdx = (commit?.args ?? []).indexOf('-m')
    expect(commit?.args[msgIdx + 1]).toBe('WIP autosalvage from run run-prev-99')
  })

  it('divergence (not ff-able) → no merge, no rebase — just leaves tree alone', async () => {
    const shell = new StubShell(async (args) => {
      if (exact(args, ['git', 'fetch', 'origin'])) return ok()
      if (exact(args, ['git', 'worktree', 'list', '--porcelain'])) {
        return ok(`worktree ${REPO}\n\nworktree ${WT}\n`)
      }
      if (exact(args, ['git', 'status', '--porcelain'])) return ok('')
      if (starts(args, ['git', 'merge-base', '--is-ancestor'])) return fail('nope', 1)
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: BASE })

    const path = await mgr.getOrCreateWorktree(TASK, REPO)

    expect(path).toBe(WT)
    // Never merges nor rebases on divergence.
    expect(shell.ran(['git', 'merge'])).toBe(false)
    expect(shell.ran(['git', 'rebase'])).toBe(false)
    expect(shell.ran(['git', 'reset', '--hard'])).toBe(false)
  })
})

// ─── removeWorktree ──────────────────────────────────────────────────────

describe('removeWorktree', () => {
  it('runs worktree remove --force + branch -D', async () => {
    const shell = new StubShell(async (args) => {
      if (starts(args, ['git', 'worktree', 'remove'])) return ok()
      if (starts(args, ['git', 'branch', '-D'])) return ok()
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: BASE })
    await mgr.removeWorktree(TASK, REPO)

    expect(shell.find(['git', 'worktree', 'remove'])?.args).toEqual([
      'git',
      'worktree',
      'remove',
      '--force',
      WT,
    ])
    expect(shell.find(['git', 'branch', '-D'])?.args).toEqual(['git', 'branch', '-D', BR])
  })
})

// ─── resolveScopes: all four combinations + multi-repo guard ────────────

describe('resolveScopes', () => {
  const mgr = new WorkspaceManager(new StubShell(() => ok()), { worktreeBase: BASE })
  const task = { id: TASK, repos: [REPO] }

  it('worktree exists + write agent → worktree in both scopes', () => {
    const scopes = mgr.resolveScopes(
      task,
      { tools: ['read_file', 'write_file'] },
      { repoBasePath: REPO, worktreeExists: true, worktreePath: WT },
    )
    expect(scopes).toEqual({ readPaths: [WT], writePaths: [WT] })
  })

  it('worktree exists + read-only agent → worktree read, empty writes', () => {
    const scopes = mgr.resolveScopes(
      task,
      { tools: ['read_file'] },
      { repoBasePath: REPO, worktreeExists: true, worktreePath: WT },
    )
    expect(scopes).toEqual({ readPaths: [WT], writePaths: [] })
  })

  it('no worktree + write agent → worktree path in both (caller will create)', () => {
    const scopes = mgr.resolveScopes(
      task,
      { tools: ['edit_file'] },
      { repoBasePath: REPO, worktreeExists: false },
    )
    expect(scopes).toEqual({ readPaths: [WT], writePaths: [WT] })
  })

  it('no worktree + read-only agent → repo base as read, empty writes', () => {
    const scopes = mgr.resolveScopes(
      task,
      { tools: ['read_file'] },
      { repoBasePath: REPO, worktreeExists: false },
    )
    expect(scopes).toEqual({ readPaths: [REPO], writePaths: [] })
  })

  it('throws explicitly for multi-repo tasks BEFORE any git op', () => {
    const multi = { id: TASK, repos: [REPO, '/repos/other'] }
    expect(() =>
      mgr.resolveScopes(
        multi,
        { tools: ['read_file'] },
        { repoBasePath: REPO, worktreeExists: false },
      ),
    ).toThrow(/2 repos/)
  })
})

// ─── Mutex behaviour ─────────────────────────────────────────────────────

describe('mutexes', () => {
  it('withTaskLock rejects a concurrent call on the same taskId', async () => {
    const mgr = new WorkspaceManager(new StubShell(() => ok()))
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })

    const first = mgr.withTaskLock('t1', async () => {
      await gate
      return 'done'
    })

    await expect(mgr.withTaskLock('t1', async () => 'nope')).rejects.toThrow(
      'task t1 ya está corriendo',
    )

    release()
    await expect(first).resolves.toBe('done')

    // Lock releases after fn resolves → next call succeeds.
    await expect(mgr.withTaskLock('t1', async () => 'again')).resolves.toBe('again')
  })

  it('serializes concurrent getOrCreateWorktree on the same repoBasePath', async () => {
    let running = 0
    let peak = 0
    const shell = new StubShell(async (args) => {
      if (exact(args, ['git', 'fetch', 'origin'])) {
        running++
        peak = Math.max(peak, running)
        await Bun.sleep(5)
        running--
        return ok()
      }
      if (exact(args, ['git', 'worktree', 'list', '--porcelain'])) {
        return ok(`worktree ${REPO}\n`)
      }
      if (starts(args, ['git', 'rev-parse', '--verify'])) return fail('nope', 1)
      if (starts(args, ['git', 'worktree', 'add'])) return ok()
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: BASE })

    await Promise.all([
      mgr.getOrCreateWorktree('t-A', REPO),
      mgr.getOrCreateWorktree('t-B', REPO),
      mgr.getOrCreateWorktree('t-C', REPO),
    ])

    expect(peak).toBe(1) // never overlapped on the same repo
  })
})
