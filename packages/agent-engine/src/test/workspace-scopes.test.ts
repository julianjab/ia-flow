import { describe, expect, it } from 'bun:test'
import type { Task } from '@ia-flow/shared'
import type { ShellResult, ShellRunner } from '../WorkspaceManager.js'
import { WorkspaceManager, worktreePathFor } from '../WorkspaceManager.js'
import { resolveWorkspaceScopes } from '../workspace-scopes.js'

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
  constructor(
    private handler: (args: string[], cwd: string) => ShellResult | Promise<ShellResult>,
  ) {}
  async run(args: string[], cwd: string): Promise<ShellResult> {
    this.calls.push({ args: [...args], cwd })
    return this.handler(args, cwd)
  }
  ran(prefix: string[]): boolean {
    return this.calls.some((c) => starts(c.args, prefix))
  }
}

const BASE = '/tmp/ia-flow-workspace-scopes-test'
const REPO = '/repos/demo'
const TASK_ID = 'PVTI_scopes001'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: 't',
    description: '',
    type: 'technical',
    repos: ['demo'],
    status: 'InProgress',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

// StubShell that answers every git call getOrCreateWorktree needs for the
// "no existing worktree/branch" happy path (mirrors WorkspaceManager.test.ts).
function creatingShell(): StubShell {
  return new StubShell(async (args) => {
    if (exact(args, ['git', 'fetch', 'origin'])) return ok()
    if (exact(args, ['git', 'worktree', 'list', '--porcelain'])) {
      return ok(`worktree ${REPO}\nHEAD abc\nbranch refs/heads/main\n`)
    }
    if (starts(args, ['git', 'rev-parse', '--verify'])) return fail('missing', 1)
    if (starts(args, ['git', 'worktree', 'add'])) return ok()
    throw new Error(`unexpected call: ${args.join(' ')}`)
  })
}

describe('resolveWorkspaceScopes', () => {
  it('sin workspaceManager → repoPaths sin tocar, sin writePaths/branch', async () => {
    const result = await resolveWorkspaceScopes({
      workspaceManager: undefined,
      agentDef: { tools: ['fs_write'] },
      resolvedProviderId: 'anthropic-api',
      task: task(),
      primaryPath: REPO,
      primaryRepoName: 'demo',
      repoPaths: { demo: REPO },
      runId: 'run1',
    })
    expect(result).toEqual({ repoPaths: { demo: REPO }, writePaths: undefined, branch: undefined })
  })

  it('resolvedProviderId !== anthropic-api (terminal provider) → no toca WorkspaceManager', async () => {
    const wsm = new WorkspaceManager(creatingShell(), { worktreeBase: BASE })
    const result = await resolveWorkspaceScopes({
      workspaceManager: wsm,
      agentDef: { tools: ['fs_write'] },
      resolvedProviderId: 'tmux-claude',
      task: task(),
      primaryPath: REPO,
      primaryRepoName: 'demo',
      repoPaths: { demo: REPO },
      runId: 'run1',
    })
    expect(result).toEqual({ repoPaths: { demo: REPO }, writePaths: undefined, branch: undefined })
  })

  it('sin primaryPath → no toca WorkspaceManager', async () => {
    const wsm = new WorkspaceManager(creatingShell(), { worktreeBase: BASE })
    const result = await resolveWorkspaceScopes({
      workspaceManager: wsm,
      agentDef: { tools: ['fs_write'] },
      resolvedProviderId: 'anthropic-api',
      task: task(),
      primaryPath: undefined,
      primaryRepoName: 'demo',
      repoPaths: {},
      runId: 'run1',
    })
    expect(result).toEqual({ repoPaths: {}, writePaths: undefined, branch: undefined })
  })

  it('sin primaryRepoName → no toca WorkspaceManager', async () => {
    const wsm = new WorkspaceManager(creatingShell(), { worktreeBase: BASE })
    const result = await resolveWorkspaceScopes({
      workspaceManager: wsm,
      agentDef: { tools: ['fs_write'] },
      resolvedProviderId: 'anthropic-api',
      task: task(),
      primaryPath: REPO,
      primaryRepoName: undefined,
      repoPaths: { demo: REPO },
      runId: 'run1',
    })
    expect(result).toEqual({ repoPaths: { demo: REPO }, writePaths: undefined, branch: undefined })
  })

  it('anthropic-api + agente con write tools → materializa el worktree y expone writePaths', async () => {
    const shell = creatingShell()
    const wsm = new WorkspaceManager(shell, { worktreeBase: BASE })
    const result = await resolveWorkspaceScopes({
      workspaceManager: wsm,
      agentDef: { tools: ['fs_write'] },
      resolvedProviderId: 'anthropic-api',
      task: task(),
      primaryPath: REPO,
      primaryRepoName: 'demo',
      repoPaths: { demo: REPO },
      runId: 'run1',
    })

    const wt = worktreePathFor(REPO, TASK_ID, BASE)
    expect(result.repoPaths.demo).toBe(wt)
    expect(result.writePaths).toEqual([wt])
    expect(result.branch).toBe('task/PVTI_scopes001')
    expect(shell.ran(['git', 'worktree', 'add'])).toBe(true)
  })

  it('anthropic-api + agente read-only, sin worktree en disco → no materializa nada, expone el repo base', async () => {
    const shell = creatingShell()
    const wsm = new WorkspaceManager(shell, { worktreeBase: BASE })
    const result = await resolveWorkspaceScopes({
      workspaceManager: wsm,
      agentDef: { tools: ['fs_read'] },
      resolvedProviderId: 'anthropic-api',
      task: task(),
      primaryPath: REPO,
      primaryRepoName: 'demo',
      repoPaths: { demo: REPO },
      runId: 'run1',
    })

    expect(result.repoPaths.demo).toBe(REPO)
    expect(result.writePaths).toEqual([])
    expect(result.branch).toBeUndefined()
    expect(shell.ran(['git', 'worktree', 'add'])).toBe(false)
  })
})
