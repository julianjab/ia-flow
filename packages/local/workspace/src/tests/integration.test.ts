/**
 * El `WorkspaceManager` con git REAL (`NodeShellRunner`) contra un repo bare local — lo que los
 * tests portados de ia-flow (con `StubShell`) no pueden probar: que la secuencia de comandos
 * funciona de verdad contra git.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { NodeShellRunner } from '../shell.js'
import { WorkspaceManager } from '../WorkspaceManager.js'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()

/** Un "GitHub" local: repo bare con `main` y la branch de un PR, y un clone para pushear. */
function fakeRemote() {
  const dir = mkdtempSync(join(tmpdir(), 'wm-remote-'))
  const bare = join(dir, 'subscriptions.git')
  const seed = join(dir, 'seed')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
  execFileSync('git', ['clone', '-q', bare, seed])
  writeFileSync(join(seed, 'README.md'), 'base\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-q', '-m', 'base')
  git(seed, 'push', '-q', 'origin', 'HEAD:main')
  git(seed, 'checkout', '-q', '-b', 'ia-flow/7')
  writeFileSync(join(seed, 'feature.txt'), 'v1\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-q', '-m', 'feature v1')
  git(seed, 'push', '-q', 'origin', 'ia-flow/7')
  return { bare, seed }
}

const repo = { name: 'subscriptions', githubOwner: 'la-haus', githubRepo: 'subscriptions' }
const task = { id: 'la-haus/subscriptions#7', issueNumber: 7 }

function manager(bare: string, opts: { syncBranchWithRemote?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wm-root-'))
  return new WorkspaceManager(new NodeShellRunner(), {
    reposBase: join(root, 'repos'),
    worktreeBase: join(root, 'worktrees'),
    cloneUrl: () => bare,
    ...opts,
  })
}

function pushV2(seed: string) {
  writeFileSync(join(seed, 'feature.txt'), 'v2\n')
  git(seed, 'commit', '-q', '-am', 'feature v2')
  git(seed, 'push', '-q', 'origin', 'ia-flow/7')
}

describe('WorkspaceManager + NodeShellRunner against real git', () => {
  let remote: ReturnType<typeof fakeRemote>
  beforeEach(() => {
    remote = fakeRemote()
  })

  it('clones once, with the local identity, and without credentials in .git/config', async () => {
    const wm = manager(remote.bare)
    const clone = await wm.ensureLocalClone(repo)
    expect(await wm.ensureLocalClone(repo)).toBe(clone)
    // Sin el helper `git`: sus `-c user.name=…` pisarían lo que se lee.
    const config = (...args: string[]) =>
      execFileSync('git', ['config', ...args], { cwd: clone, encoding: 'utf8' }).trim()
    expect(config('user.name')).toBe('ia-tools-bot')
    expect(config('--list')).not.toMatch(/extraheader|x-access-token/i)
  })

  it('checks out an existing remote branch in a readable task-<n> worktree, with the base fetched', async () => {
    const wm = manager(remote.bare)
    const clone = await wm.ensureLocalClone(repo)
    const { path, branch } = await wm.getOrCreateWorktree(task, clone, { branch: 'ia-flow/7' })
    expect(branch).toBe('ia-flow/7')
    expect(path.endsWith(join('subscriptions', '.worktrees', 'task-7'))).toBe(true)
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ia-flow/7')
    expect(readFileSync(join(path, 'feature.txt'), 'utf8')).toBe('v1\n')
    expect(git(path, 'diff', '--name-only', 'origin/main...HEAD')).toBe('feature.txt')
  })

  it('creates a new branch from the base when it does not exist anywhere', async () => {
    const wm = manager(remote.bare)
    const clone = await wm.ensureLocalClone(repo)
    const { path } = await wm.getOrCreateWorktree({ id: 'x#8', issueNumber: 8 }, clone, {
      branch: 'ia-flow/8',
    })
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ia-flow/8')
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(clone, 'rev-parse', 'origin/main'))
  })

  it('with syncBranchWithRemote, a reuse picks up what someone else pushed to the branch', async () => {
    const wm = manager(remote.bare, { syncBranchWithRemote: true })
    const clone = await wm.ensureLocalClone(repo)
    const { path } = await wm.getOrCreateWorktree(task, clone, { branch: 'ia-flow/7' })
    pushV2(remote.seed)
    await wm.getOrCreateWorktree(task, clone, { branch: 'ia-flow/7' })
    expect(readFileSync(join(path, 'feature.txt'), 'utf8')).toBe('v2\n')
  })

  it("without it (ia-flow's behaviour), a reuse keeps the local tip", async () => {
    const wm = manager(remote.bare)
    const clone = await wm.ensureLocalClone(repo)
    const { path } = await wm.getOrCreateWorktree(task, clone, { branch: 'ia-flow/7' })
    pushV2(remote.seed)
    await wm.getOrCreateWorktree(task, clone, { branch: 'ia-flow/7' })
    expect(readFileSync(join(path, 'feature.txt'), 'utf8')).toBe('v1\n')
  })

  it('never syncs over local commits the remote does not have (divergence)', async () => {
    const wm = manager(remote.bare, { syncBranchWithRemote: true })
    const clone = await wm.ensureLocalClone(repo)
    const { path } = await wm.getOrCreateWorktree(task, clone, { branch: 'ia-flow/7' })
    writeFileSync(join(path, 'local.txt'), 'mío\n')
    git(path, 'add', '.')
    git(path, 'commit', '-q', '-m', 'local')
    const localTip = git(path, 'rev-parse', 'HEAD')
    pushV2(remote.seed)
    await wm.getOrCreateWorktree(task, clone, { branch: 'ia-flow/7' })
    expect(git(path, 'rev-parse', 'HEAD')).toBe(localTip)
  })
})

describe('WorkspaceManager — worktree por carril (grupo parallel)', () => {
  it('cada carril tiene su worktree, en --detach sobre la branch de la task, y se va con ella', async () => {
    const remote = fakeRemote()
    const wm = manager(remote.bare)
    const clone = await wm.ensureLocalClone(repo)

    const reviewer = await wm.getOrCreateLaneWorktree(task, clone, 'reviewer', {
      branch: 'ia-flow/7',
    })
    const e2e = await wm.getOrCreateLaneWorktree(task, clone, 'e2e', { branch: 'ia-flow/7' })
    const { path: main } = await wm.getOrCreateWorktree(task, clone, { branch: 'ia-flow/7' })

    expect(reviewer.path).toBe(`${main}--reviewer`)
    expect(e2e.path).not.toBe(reviewer.path)
    expect(readFileSync(join(reviewer.path, 'feature.txt'), 'utf8')).toBe('v1\n')
    // Detached en el mismo commit que la branch de la task.
    expect(git(reviewer.path, 'rev-parse', 'HEAD')).toBe(git(main, 'rev-parse', 'HEAD'))
    expect(git(reviewer.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')

    // Lo que un carril ensucia no le llega al otro, y refrescarlo lo descarta.
    writeFileSync(join(reviewer.path, 'feature.txt'), 'tocado\n')
    expect(readFileSync(join(e2e.path, 'feature.txt'), 'utf8')).toBe('v1\n')
    pushV2(remote.seed)
    const again = await wm.getOrCreateLaneWorktree(task, clone, 'reviewer', { branch: 'ia-flow/7' })
    expect(again.path).toBe(reviewer.path)
    expect(git(again.path, 'rev-parse', 'HEAD')).toBe(git(main, 'rev-parse', 'HEAD'))

    await wm.removeWorktree(task, clone, 'ia-flow/7')
    const listed = git(clone, 'worktree', 'list', '--porcelain')
    expect(listed).not.toContain('--reviewer')
    expect(listed).not.toContain('--e2e')
  })
})

describe('NodeShellRunner', () => {
  it('returns the exit code instead of throwing, and runs without a shell', async () => {
    const shell = new NodeShellRunner()
    const dir = mkdtempSync(join(tmpdir(), 'nsr-'))
    const fail = await shell.run(['git', 'rev-parse', '--verify', 'nope'], dir)
    expect(fail.exitCode).not.toBe(0)
    const echo = await shell.run(['echo', '$HOME && ls'], dir)
    expect(echo.stdout.trim()).toBe('$HOME && ls')
  })

  it('throws only when the binary does not exist', async () => {
    await expect(new NodeShellRunner().run(['no-such-binary-xyz'], tmpdir())).rejects.toThrow()
  })
})
