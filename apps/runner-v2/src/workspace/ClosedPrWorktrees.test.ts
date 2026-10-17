import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ShellResult, ShellRunner } from '@ia-flow/workspace'
import {
  type BranchPullRequest,
  ClosedPrWorktrees,
  closedPullRequest,
  githubPullRequests,
  parseWorktreeList,
} from './ClosedPrWorktrees.js'

const ok = (stdout = ''): ShellResult => ({ exitCode: 0, stdout, stderr: '' })

const NOW = Date.parse('2026-10-16T12:00:00Z')
const AN_HOUR_AGO = '2026-10-16T11:00:00Z'
const A_MINUTE_AGO = '2026-10-16T11:59:00Z'

const merged = (closedAt = AN_HOUR_AGO): BranchPullRequest => ({
  number: 12,
  open: false,
  merged: true,
  closedAt,
})

/** El listado de un clone: el clone primero, después sus worktrees. */
function porcelain(clone: string, trees: Array<{ path: string; branch?: string }>): string {
  return [{ path: clone, branch: 'main' }, ...trees]
    .map(({ path, branch }) =>
      [`worktree ${path}`, 'HEAD abc123', branch ? `branch refs/heads/${branch}` : 'detached'].join(
        '\n',
      ),
    )
    .join('\n\n')
}

describe('ClosedPrWorktrees', () => {
  let reposBase: string
  let clone: string
  beforeEach(async () => {
    reposBase = await mkdtemp(join(tmpdir(), 'closed-prs-'))
    clone = join(reposBase, 'la-haus', 'eks')
    await mkdir(clone, { recursive: true })
  })
  afterEach(() => rm(reposBase, { recursive: true, force: true }))

  function sweeper(
    trees: Array<{ path: string; branch?: string }>,
    prs: Record<string, BranchPullRequest[] | Error>,
    over: { safe?: boolean; busy?: (path: string) => boolean } = {},
  ) {
    const commands: string[] = []
    const removed: unknown[][] = []
    const lines: string[] = []
    const asked: string[] = []
    const shell: ShellRunner = {
      run: async (argv, cwd) => {
        const cmd = argv.join(' ')
        commands.push(`${cmd} @ ${cwd}`)
        if (cmd === 'git worktree prune') return ok()
        if (cmd === 'git worktree list --porcelain') return ok(porcelain(clone, trees))
        throw new Error(`comando inesperado: ${cmd}`)
      },
    }
    const janitor = new ClosedPrWorktrees({
      shell,
      workspace: {
        removeWorktree: async (...args) => {
          removed.push(args)
        },
        isWorktreeSafeToRemove: async () => over.safe ?? true,
      },
      reposBase,
      pullRequests: async (owner, repo, branch) => {
        asked.push(`${owner}/${repo}:${branch}`)
        const found = prs[branch] ?? []
        if (found instanceof Error) throw found
        return found
      },
      ...(over.busy ? { busy: over.busy } : {}),
      log: {
        info: (line) => lines.push(`info ${line}`),
        warn: (line) => lines.push(`warn ${line}`),
      },
      now: () => NOW,
    })
    return { janitor, commands, removed, lines, asked }
  }

  it('a merged PR: the worktree goes, with its lanes and the local branch', async () => {
    const { janitor, removed, lines, asked, commands } = sweeper(
      [{ path: '/wt/task-7', branch: 'feat/x' }, { path: '/wt/task-7--reviewer' }],
      { 'feat/x': [merged()] },
    )
    expect(await janitor.sweep()).toEqual(['/wt/task-7'])
    expect(asked).toEqual(['la-haus/eks:feat/x'])
    // `removeWorktree` borra también los carriles y la branch local.
    expect(removed).toEqual([['task-7', clone, 'feat/x', '/wt/task-7']])
    expect(lines).toEqual([
      'info [workspace] worktree borrado: /wt/task-7 (feat/x, PR #12 mergeado)',
    ])
    expect(commands[0]).toBe(`git worktree prune @ ${clone}`)
  })

  it('merged without unpushed checks: a squash leaves local commits that are already in the base', async () => {
    const { janitor, removed } = sweeper(
      [{ path: '/wt/task-7', branch: 'feat/x' }],
      {
        'feat/x': [merged()],
      },
      { safe: false },
    )
    expect(await janitor.sweep()).toEqual(['/wt/task-7'])
    expect(removed).toHaveLength(1)
  })

  it('stays while the PR is open, has no PR, or was closed less than the grace period ago', async () => {
    const { janitor, removed } = sweeper(
      [
        { path: '/wt/task-1', branch: 'feat/open' },
        { path: '/wt/task-2', branch: 'feat/no-pr' },
        { path: '/wt/task-3', branch: 'feat/just-merged' },
        { path: '/wt/task-4', branch: 'feat/reopened' },
      ],
      {
        'feat/open': [{ number: 1, open: true, merged: false }],
        'feat/just-merged': [merged(A_MINUTE_AGO)],
        // Un PR cerrado y otro abierto de la misma branch: sigue viva.
        'feat/reopened': [merged(), { number: 2, open: true, merged: false }],
      },
    )
    expect(await janitor.sweep()).toEqual([])
    expect(removed).toEqual([])
  })

  it('closed without merge: goes only if nothing is outside the remote', async () => {
    const closed = { 'feat/x': [{ number: 3, open: false, merged: false, closedAt: AN_HOUR_AGO }] }
    const unsafe = sweeper([{ path: '/wt/task-7', branch: 'feat/x' }], closed, { safe: false })
    expect(await unsafe.janitor.sweep()).toEqual([])
    expect(unsafe.lines).toEqual([
      'warn [workspace] /wt/task-7 (feat/x, PR #3 cerrado) tiene trabajo afuera del remoto: no se borra solo',
    ])
    const safe = sweeper([{ path: '/wt/task-7', branch: 'feat/x' }], closed, { safe: true })
    expect(await safe.janitor.sweep()).toEqual(['/wt/task-7'])
  })

  it('never touches a worktree in use, nor one whose lane is', async () => {
    const { janitor, removed } = sweeper(
      [{ path: '/wt/task-7', branch: 'feat/x' }, { path: '/wt/task-7--e2e-visual-qa' }],
      { 'feat/x': [merged()] },
      { busy: (path) => path === '/wt/task-7--e2e-visual-qa' },
    )
    expect(await janitor.sweep()).toEqual([])
    expect(removed).toEqual([])
  })

  it('a GitHub that does not answer leaves it for the next sweep', async () => {
    const { janitor, removed, lines } = sweeper([{ path: '/wt/task-7', branch: 'feat/x' }], {
      'feat/x': new Error('502'),
    })
    expect(await janitor.sweep()).toEqual([])
    expect(removed).toEqual([])
    expect(lines).toEqual(['warn [workspace] no se pudo consultar el PR de feat/x: Error: 502'])
  })

  it('a lane with no task worktree, or nothing cloned yet: nothing to ask', async () => {
    const { janitor, asked } = sweeper([{ path: '/wt/task-9--reviewer' }], {})
    expect(await janitor.sweep()).toEqual([])
    expect(asked).toEqual([])
    await rm(reposBase, { recursive: true, force: true })
    expect(await janitor.sweep()).toEqual([])
  })
})

describe('closedPullRequest', () => {
  it('none while one is open; otherwise the last one closed', () => {
    expect(closedPullRequest([])).toBeUndefined()
    expect(closedPullRequest([merged(), { number: 2, open: true, merged: false }])).toBeUndefined()
    const older = { number: 1, open: false, merged: false, closedAt: '2026-10-01T00:00:00Z' }
    expect(closedPullRequest([older, merged()])?.number).toBe(12)
  })
})

describe('parseWorktreeList', () => {
  it('path and branch of each block; a detached HEAD has no branch', () => {
    expect(
      parseWorktreeList(
        'worktree /repo\nHEAD a\nbranch refs/heads/main\n\nworktree /wt/t--r\nHEAD b\ndetached\nprunable gitdir file points to non-existent location\n',
      ),
    ).toEqual([{ path: '/repo', branch: 'main' }, { path: '/wt/t--r' }])
  })
})

describe('githubPullRequests', () => {
  it('asks for every PR of the branch head and keeps what decides', async () => {
    const paths: string[] = []
    const lookup = githubPullRequests({
      requestJson: async <T>(path: string) => {
        paths.push(path)
        return [
          { number: 4, state: 'closed', merged_at: AN_HOUR_AGO, closed_at: AN_HOUR_AGO },
          { number: 5, state: 'open', merged_at: null, closed_at: null },
        ] as T
      },
    })
    expect(await lookup('la-haus', 'eks', 'feat/x')).toEqual([
      { number: 4, open: false, merged: true, closedAt: AN_HOUR_AGO },
      { number: 5, open: true, merged: false },
    ])
    expect(paths).toEqual([
      '/repos/la-haus/eks/pulls?head=la-haus%3Afeat%2Fx&state=all&per_page=20',
    ])
  })
})
