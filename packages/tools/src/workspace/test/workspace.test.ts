import { afterEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, WorkspaceManagerPort } from '../../contract.js'
import { getTool } from '../../engine.js'
// Side-effect import — registers `fs_read`, needed for the range-coverage
// regression test below (reset must invalidate fs_read's accumulated ranges,
// not just ctx.readPaths itself).
import '../../fs/fs.js'
// Side-effect import — registers `reset_worktree` in the global tool registry.
import '../workspace.js'
import { setWorkspaceManagerPort } from '../workspace.js'

// Minimal duck-typed stub cast as WorkspaceManager. The tool only calls
// `resetWorktree`, so we don't need to fake the full public surface.
// `resetWorktree` returns the new worktree path as a plain string.
function stubManager(behaviour: (taskId: string) => Promise<string>): WorkspaceManagerPort {
  return { resetWorktree: behaviour }
}

// Every write-tool call needs `writePaths` populated — the tool refuses on
// empty scope before doing anything else. The specific value doesn't matter
// (nothing hits disk in these tests); the shape does.
const writableCtx: ToolContext = { repoPaths: {}, writePaths: ['/wt'] }

afterEach(() => {
  // Reset the module-level singleton between cases so a stub from one test
  // doesn't leak into the next (all tests share the process-wide registry).
  setWorkspaceManagerPort(null)
})

describe('reset_worktree tool', () => {
  it('delegates to WorkspaceManager.resetWorktree and returns new path + reflog hint', async () => {
    const resetMock = mock(async (_taskId: string) => '/tmp/ia-flow/demo/.worktrees/task-1')
    setWorkspaceManagerPort({ resetWorktree: resetMock })

    const tool = getTool('reset_worktree')
    expect(tool).toBeDefined()

    const out = await tool!.execute({ task_id: 'task-1' }, writableCtx)

    expect(resetMock).toHaveBeenCalledTimes(1)
    expect(resetMock.mock.calls[0][0]).toBe('task-1')
    expect(out).toContain('Worktree reseteado para task task-1')
    expect(out).toContain('/tmp/ia-flow/demo/.worktrees/task-1')
    // Rescue path must be echoed with the reflog hint referring to the
    // task branch (task/<id>).
    expect(out).toContain('reflog')
    expect(out).toContain('task/task-1')
  })

  it('accepts empty input `{}` and derives task_id from ctx.taskId (write-tool contract)', async () => {
    // Mirrors the PRD requirement: the tool schema declares `task_id` as
    // optional, and the provider anthropic-api propagates the run's task
    // id into `ToolContext.taskId`. The agent should be able to fire the
    // escape hatch without knowing/passing the id itself.
    const resetMock = mock(async (_taskId: string) => '/tmp/wt/task-99')
    setWorkspaceManagerPort({ resetWorktree: resetMock })
    const tool = getTool('reset_worktree')!

    const out = await tool.execute({}, { ...writableCtx, taskId: 'task-99' })

    expect(resetMock).toHaveBeenCalledTimes(1)
    expect(resetMock.mock.calls[0][0]).toBe('task-99')
    expect(out).toContain('task task-99')
  })

  it('refuses when writePaths is empty (mirrors write_file / edit_file guard)', async () => {
    // The message must contain the same stable substring that write/edit
    // emit, so an operator can grep for one string across all write tools.
    setWorkspaceManagerPort(stubManager(async () => '/x'))
    const tool = getTool('reset_worktree')!
    const out = await tool.execute({ task_id: 'task-1' }, { repoPaths: {} })
    expect(out).toContain('escritura no permitida en fase actual')
  })

  it('surfaces manager errors as a tool-result string instead of throwing', async () => {
    setWorkspaceManagerPort(
      stubManager(async () => {
        throw new Error('git fetch origin failed: network down')
      }),
    )
    const tool = getTool('reset_worktree')!
    const out = await tool.execute({ task_id: 'task-1' }, writableCtx)
    expect(out).toContain('reset_worktree failed:')
    expect(out).toContain('network down')
  })

  it('returns explicit "unavailable" error when WorkspaceManager is not wired', async () => {
    setWorkspaceManagerPort(null)
    const tool = getTool('reset_worktree')!
    const out = await tool.execute({ task_id: 'task-1' }, writableCtx)
    expect(out).toContain('unavailable')
    expect(out).toContain('WorkspaceManager')
  })

  it('rejects call when neither task_id nor ctx.taskId is present', async () => {
    setWorkspaceManagerPort(stubManager(async () => '/x'))
    const tool = getTool('reset_worktree')!
    const out = await tool.execute({}, writableCtx)
    // The error must cite both fallbacks so an operator debugging a bad
    // provider knows where to look (ctx propagation vs input).
    expect(out).toContain('task_id')
    expect(out).toContain('ctx.taskId')
  })

  it('clears ctx.readPaths on a successful reset — the disk content changed underneath it', async () => {
    // Regression: after a reset, the worktree reverts to origin/main. A
    // stale readPaths entry would let fs_write overwrite a path the run
    // never actually saw in its POST-reset state.
    const resetMock = mock(async (_taskId: string) => '/tmp/wt/task-1')
    setWorkspaceManagerPort({ resetWorktree: resetMock })
    const tool = getTool('reset_worktree')!
    const readPaths = new Set(['/tmp/wt/task-1/a.ts', '/tmp/wt/task-1/b.ts'])

    await tool.execute({ task_id: 'task-1' }, { ...writableCtx, readPaths })

    expect(readPaths.size).toBe(0)
  })

  it("reset also invalidates fs_read's accumulated range coverage — a partial re-read after reset does not resurrect the mark", async () => {
    // Regression: `rangeCoverage` (fs.ts) is keyed by the readPaths Set
    // instance. Clearing the Set's contents alone leaves the OLD ranges
    // alive in that WeakMap; a fresh PARTIAL read after the reset could
    // complete the stale coverage and wrongly re-mark the path.
    const repoRoot = mkdtempSync(join(tmpdir(), 'ia-flow-reset-coverage-'))
    try {
      writeFileSync(
        join(repoRoot, 'a.ts'),
        Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'),
      )
      const readPaths = new Set<string>()
      const repoPaths = { r: repoRoot }
      const readTool = getTool('fs_read')!
      const abs = join(repoRoot, 'a.ts')

      // Full read: marks the path AND records full-file coverage.
      await readTool.execute({ path: 'r/a.ts', offset: 1 }, { repoPaths, readPaths })
      expect(readPaths.has(abs)).toBe(true)

      setWorkspaceManagerPort({ resetWorktree: async () => repoRoot })
      const resetTool = getTool('reset_worktree')!
      await resetTool.execute(
        { task_id: 'task-1' },
        { repoPaths, writePaths: [repoRoot], readPaths },
      )
      expect(readPaths.has(abs)).toBe(false)

      // Only 1 of 10 lines read post-reset — must NOT be enough to mark it.
      await readTool.execute({ path: 'r/a.ts', offset: 1, limit: 1 }, { repoPaths, readPaths })
      expect(readPaths.has(abs)).toBe(false)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  it('does not touch ctx.readPaths when the reset fails', async () => {
    setWorkspaceManagerPort(
      stubManager(async () => {
        throw new Error('git fetch origin failed: network down')
      }),
    )
    const tool = getTool('reset_worktree')!
    const readPaths = new Set(['/tmp/wt/task-1/a.ts'])

    await tool.execute({ task_id: 'task-1' }, { ...writableCtx, readPaths })

    expect(readPaths.size).toBe(1)
  })

  it('is restricted to sync providers (excluded from async curl appendix)', () => {
    const tool = getTool('reset_worktree')!
    // Only anthropic-api (sync) builds the WorkspaceManager sandbox. Terminal
    // providers (tmux/iterm) have no worktree to reset, so declaring
    // `providerKinds: ['sync']` keeps the tool out of `buildToolInstructions`
    // and out of the API tool list for async providers.
    expect(tool.providerKinds).toEqual(['sync'])
  })

  it('is marked apiOnly at the registry level (documentation flag)', () => {
    const tool = getTool('reset_worktree')!
    // `apiOnly` is intentionally documentation-only — the actual exclusion
    // is done via `providerKinds` — but the marker must still be set so a
    // reader spots the sandbox dependency without inferring it.
    expect(tool.apiOnly).toBe(true)
  })
})
