import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_WORKTREE_BASE,
  type ShellResult,
  type ShellRunner,
  WorkspaceManager,
  branchNameFor,
  hasWriteTools,
  needsWorkspace,
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

  it('hasWriteTools recognises fs_write / fs_edit / bash_run', () => {
    expect(hasWriteTools({ tools: ['fs_read'] })).toBe(false)
    expect(hasWriteTools({ tools: ['fs_write'] })).toBe(true)
    expect(hasWriteTools({ tools: ['fs_edit'] })).toBe(true)
    expect(hasWriteTools({ tools: [{ name: 'bash_run', allow: [], deny: [] }] })).toBe(true)
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

    const { path, branch } = await mgr.getOrCreateWorktree(TASK, REPO)

    expect(path).toBe(WT)
    expect(branch).toBe(BR)
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

    const { path } = await mgr.getOrCreateWorktree(TASK, REPO)

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
      { tools: ['fs_read', 'fs_write'] },
      { repoBasePath: REPO, worktreeExists: true, worktreePath: WT },
    )
    expect(scopes).toEqual({ readPaths: [WT], writePaths: [WT] })
  })

  it('worktree exists + read-only agent → worktree read, empty writes', () => {
    const scopes = mgr.resolveScopes(
      task,
      { tools: ['fs_read'] },
      { repoBasePath: REPO, worktreeExists: true, worktreePath: WT },
    )
    expect(scopes).toEqual({ readPaths: [WT], writePaths: [] })
  })

  it('no worktree + write agent → worktree path in both (caller will create)', () => {
    const scopes = mgr.resolveScopes(
      task,
      { tools: ['fs_edit'] },
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

// ─── needsWorkspace ──────────────────────────────────────────────────────

describe('needsWorkspace', () => {
  it('true only when anthropic-api is among the providers', () => {
    expect(needsWorkspace(['anthropic-api'])).toBe(true)
    expect(needsWorkspace(['tmux-claude', 'anthropic-api'])).toBe(true)
    expect(needsWorkspace(['tmux-claude'])).toBe(false)
    expect(needsWorkspace([])).toBe(false)
    expect(needsWorkspace([undefined])).toBe(false)
  })
})

// ─── ensureLocalClone ────────────────────────────────────────────────────

describe('ensureLocalClone', () => {
  const REPOS_BASE = `/tmp/ia-flow-clone-test-${Date.now()}`

  it('throws when reposBase is not configured', async () => {
    const mgr = new WorkspaceManager(new StubShell(() => ok()))
    await expect(
      mgr.ensureLocalClone({ name: 'demo', githubOwner: 'acme', githubRepo: 'demo' }),
    ).rejects.toThrow(/reposBase/)
  })

  it('throws when the repo has no githubOwner/githubRepo', async () => {
    const mgr = new WorkspaceManager(new StubShell(() => ok()), { reposBase: REPOS_BASE })
    await expect(mgr.ensureLocalClone({ name: 'demo' })).rejects.toThrow(/githubOwner/)
  })

  it('clones and sets local git identity when the repo is not cloned yet', async () => {
    // Matchea por subcomando, no por prefijo: la credencial viaja como flags
    // `-c` que se interponen entre `git` y el subcomando.
    const shell = new StubShell(async (args) => {
      if (args.includes('clone') || args.includes('config')) return ok()
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, {
      reposBase: REPOS_BASE,
      githubToken: 'tok123',
      gitAuthorName: 'ia-flow-bot',
      gitAuthorEmail: 'bot@ia-flow.local',
    })

    const dest = await mgr.ensureLocalClone({
      name: 'demo',
      githubOwner: 'acme',
      githubRepo: 'demo',
    })

    expect(dest).toBe(join(REPOS_BASE, 'acme', 'demo'))
    // El token va como `-c http.extraHeader`, NO embebido en la URL: `git
    // clone` persiste la URL en `.git/config`, y este clone es la base de los
    // worktrees de los agentes — un PAT ahí sería legible con fs.read.
    // `find` matchea por prefijo y los flags `-c` van antes del subcomando,
    // así que ubicamos la llamada por el subcomando en sí.
    const clone = shell.calls.find((c) => c.args.includes('clone'))
    const basic = Buffer.from('x-access-token:tok123').toString('base64')
    expect(clone?.args).toEqual([
      'git',
      '-c',
      `http.extraHeader=Authorization: Basic ${basic}`,
      'clone',
      'https://github.com/acme/demo.git',
      dest,
    ])
    expect(clone?.args.join(' ')).not.toContain('tok123')
    expect(shell.find(['git', 'config', 'user.name'])?.args).toEqual([
      'git',
      'config',
      'user.name',
      'ia-flow-bot',
    ])
    expect(shell.find(['git', 'config', 'user.email'])?.args).toEqual([
      'git',
      'config',
      'user.email',
      'bot@ia-flow.local',
    ])
  })

  it('is idempotent — skips clone when the destination is already a git repo', async () => {
    const dest = join(REPOS_BASE, 'acme', 'already-cloned')
    mkdirSync(join(dest, '.git'), { recursive: true })
    const shell = new StubShell(() => ok())
    const mgr = new WorkspaceManager(shell, { reposBase: REPOS_BASE })

    const result = await mgr.ensureLocalClone({
      name: 'already-cloned',
      githubOwner: 'acme',
      githubRepo: 'already-cloned',
    })

    expect(result).toBe(dest)
    expect(shell.ran(['git', 'clone'])).toBe(false)
  })

  it('clones without a token embedded when no githubToken is configured', async () => {
    const shell = new StubShell(async (args) => {
      if (starts(args, ['git', 'clone'])) return ok()
      if (starts(args, ['git', 'config'])) return ok()
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { reposBase: REPOS_BASE })

    await mgr.ensureLocalClone({ name: 'pub', githubOwner: 'acme', githubRepo: 'pub' })

    const clone = shell.find(['git', 'clone'])
    expect(clone?.args[2]).toBe('https://github.com/acme/pub.git')
  })
})

// ─── cleanupTerminalWorktree ─────────────────────────────────────────────

describe('cleanupTerminalWorktree', () => {
  it('treats a git failure on the safety check as unsafe — skips remove', async () => {
    const shell = new StubShell(() => fail('boom', 1))
    const mgr = new WorkspaceManager(shell, {
      worktreeBase: `/tmp/ia-flow-cleanup-unsafe-${Date.now()}`,
    })

    await mgr.cleanupTerminalWorktree('t-missing', REPO, BR)

    expect(shell.ran(['git', 'worktree', 'remove'])).toBe(false)
  })

  it('removes the worktree when it exists on disk and is safe to remove', async () => {
    const base = `/tmp/ia-flow-cleanup-safe-${Date.now()}`
    const taskId = 't-safe'
    const shell = new StubShell(async (args) => {
      if (exact(args, ['git', 'status', '--porcelain'])) return ok('')
      if (starts(args, ['git', 'ls-remote', '--exit-code'])) return fail('absent', 2)
      if (starts(args, ['git', 'log', '--oneline'])) return ok('')
      if (starts(args, ['git', 'worktree', 'remove'])) return ok()
      if (starts(args, ['git', 'branch', '-D'])) return ok()
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: base })

    await mgr.cleanupTerminalWorktree(taskId, REPO, BR)

    expect(shell.ran(['git', 'worktree', 'remove'])).toBe(true)
    expect(shell.ran(['git', 'branch', '-D'])).toBe(true)
  })

  it('leaves the worktree alone when it has unsafe (dirty) state', async () => {
    const base = `/tmp/ia-flow-cleanup-dirty-${Date.now()}`
    const taskId = 't-dirty'
    const wtPath = worktreePathFor(REPO, taskId, base)
    mkdirSync(wtPath, { recursive: true })
    const shell = new StubShell(async (args) => {
      if (exact(args, ['git', 'status', '--porcelain'])) return ok('M file.ts\n')
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: base })

    await mgr.cleanupTerminalWorktree(taskId, REPO, BR)

    expect(shell.ran(['git', 'worktree', 'remove'])).toBe(false)
    expect(existsSync(wtPath)).toBe(true)
  })
})

// ─── isBranchEmptyVsBase / borrado de la branch remota ───────────────────

const SHA = 'a1b2c3d4e5f6'

/**
 * Stub para el camino "branch limpia": safety check OK + resolución de base.
 * `overrides` decide qué responden `rev-list` y `diff` (lo que distingue una
 * branch vacía de una con trabajo real).
 */
function emptyBranchShell(overrides: Handler): StubShell {
  return new StubShell(async (args, cwd) => {
    if (exact(args, ['git', 'status', '--porcelain'])) return ok('')
    if (starts(args, ['git', 'symbolic-ref'])) return ok('origin/main\n')
    if (starts(args, ['git', 'fetch'])) return ok()
    if (starts(args, ['git', 'ls-remote'])) return ok(`${SHA}\trefs/heads/x`)
    if (starts(args, ['git', 'rev-parse', '--verify'])) return ok(`${SHA}\n`)
    if (starts(args, ['git', 'log', '--oneline'])) return ok('')
    if (starts(args, ['git', 'worktree', 'remove'])) return ok()
    if (starts(args, ['git', 'branch', '-D'])) return ok()
    if (starts(args, ['git', 'push'])) return ok()
    return overrides(args, cwd)
  })
}

describe('isBranchEmptyVsBase', () => {
  it('es true cuando la branch remota no tiene commits sobre la base', async () => {
    const shell = emptyBranchShell((args) => {
      if (starts(args, ['git', 'rev-list', '--count'])) return ok('0\n')
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: BASE })

    expect(await mgr.isBranchEmptyVsBase(WT, BR)).toBe(true)
    expect(shell.find(['git', 'rev-list', '--count'])?.args[3]).toBe(`origin/main..origin/${BR}`)
  })

  it('es true cuando tiene commits pero el árbol es idéntico a la base', async () => {
    const shell = emptyBranchShell((args) => {
      if (starts(args, ['git', 'rev-list', '--count'])) return ok('2\n')
      if (starts(args, ['git', 'diff', '--quiet'])) return ok()
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: BASE })

    expect(await mgr.isBranchEmptyVsBase(WT, BR)).toBe(true)
  })

  it('es false cuando la branch cambia el árbol', async () => {
    const shell = emptyBranchShell((args) => {
      if (starts(args, ['git', 'rev-list', '--count'])) return ok('2\n')
      if (starts(args, ['git', 'diff', '--quiet'])) return fail('differs', 1)
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: BASE })

    expect(await mgr.isBranchEmptyVsBase(WT, BR)).toBe(false)
  })

  it('es false cuando la branch no existe en el remoto', async () => {
    const shell = new StubShell(async (args) => {
      if (starts(args, ['git', 'symbolic-ref'])) return ok('origin/main\n')
      if (starts(args, ['git', 'fetch'])) return ok()
      if (starts(args, ['git', 'ls-remote'])) return fail('absent', 2)
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: BASE })

    expect(await mgr.isBranchEmptyVsBase(WT, BR)).toBe(false)
  })

  it('es false si el fetch falla — no confía en refs rancias', async () => {
    const shell = new StubShell(async (args) => {
      if (starts(args, ['git', 'symbolic-ref'])) return ok('origin/main\n')
      if (starts(args, ['git', 'fetch'])) return fail('network down', 1)
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: BASE })

    expect(await mgr.isBranchEmptyVsBase(WT, BR)).toBe(false)
    expect(shell.ran(['git', 'ls-remote'])).toBe(false)
  })

  it('es false si origin/<branch> local no coincide con el SHA del remoto', async () => {
    const shell = new StubShell(async (args) => {
      if (starts(args, ['git', 'symbolic-ref'])) return ok('origin/main\n')
      if (starts(args, ['git', 'fetch'])) return ok()
      if (starts(args, ['git', 'ls-remote'])) return ok(`${SHA}\trefs/heads/x`)
      // Ref local vieja: alguien pushó desde otra máquina después del fetch.
      if (starts(args, ['git', 'rev-parse', '--verify'])) return ok('deadbeef\n')
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: BASE })

    expect(await mgr.isBranchEmptyVsBase(WT, BR)).toBe(false)
    expect(shell.ran(['git', 'rev-list'])).toBe(false)
  })

  it('nunca considera vacía a la base ni a main/master/develop', async () => {
    const shell = new StubShell(async (args) => {
      if (starts(args, ['git', 'symbolic-ref'])) return ok('origin/release\n')
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: BASE })

    expect(await mgr.isBranchEmptyVsBase(WT, 'main')).toBe(false)
    expect(await mgr.isBranchEmptyVsBase(WT, 'release')).toBe(false)
    expect(shell.ran(['git', 'ls-remote'])).toBe(false)
  })
})

describe('cleanupTerminalWorktree — borrado remoto', () => {
  it('borra la branch del remoto cuando no difiere de la base', async () => {
    const shell = emptyBranchShell((args) => {
      if (starts(args, ['git', 'rev-list', '--count'])) return ok('0\n')
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: `/tmp/ia-flow-rm-remote` })

    await mgr.cleanupTerminalWorktree(TASK, REPO, BR)

    expect(shell.ran(['git', 'branch', '-D'])).toBe(true)
    const push = shell.find(['git', 'push'])
    expect(push?.args).toEqual(['git', 'push', 'origin', '--delete', BR])
    expect(push?.cwd).toBe(REPO)
    // El chequeo debe correr ANTES del remove (el worktree aún existe).
    const checkIdx = shell.calls.findIndex((c) => starts(c.args, ['git', 'rev-list']))
    const removeIdx = shell.calls.findIndex((c) => starts(c.args, ['git', 'worktree', 'remove']))
    expect(checkIdx).toBeLessThan(removeIdx)
  })

  it('no toca el remoto cuando la branch aporta cambios', async () => {
    const shell = emptyBranchShell((args) => {
      if (starts(args, ['git', 'rev-list', '--count'])) return ok('1\n')
      if (starts(args, ['git', 'diff', '--quiet'])) return fail('differs', 1)
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, { worktreeBase: `/tmp/ia-flow-keep-remote` })

    await mgr.cleanupTerminalWorktree(TASK, REPO, BR)

    expect(shell.ran(['git', 'worktree', 'remove'])).toBe(true)
    expect(shell.ran(['git', 'push'])).toBe(false)
  })

  it('respeta el kill-switch deleteEmptyBranches:false', async () => {
    const shell = emptyBranchShell((args) => {
      if (starts(args, ['git', 'rev-list', '--count'])) return ok('0\n')
      throw new Error(`unexpected: ${args.join(' ')}`)
    })
    const mgr = new WorkspaceManager(shell, {
      worktreeBase: `/tmp/ia-flow-killswitch`,
      deleteEmptyBranches: false,
    })

    await mgr.cleanupTerminalWorktree(TASK, REPO, BR)

    expect(shell.ran(['git', 'worktree', 'remove'])).toBe(true)
    expect(shell.ran(['git', 'push'])).toBe(false)
    expect(shell.ran(['git', 'rev-list'])).toBe(false)
  })
})
