import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { WorkspaceManager } from '../application/WorkspaceManager.js'
import type { ToolContext } from './index.js'
import { getTool } from './index.js'
// Side-effect import — registers `reset_worktree` in the global tool registry.
import './workspace.js'
import { setWorkspaceManager } from './workspace.js'

interface ResetResult {
  path: string
  previousSha: string | null
  newSha: string | null
}

// Minimal duck-typed stub cast as WorkspaceManager. The tool only calls
// `resetWorktree`, so we don't need to fake the full public surface.
function stubManager(
  behaviour: (taskId: string) => Promise<ResetResult>,
): WorkspaceManager {
  return { resetWorktree: behaviour } as unknown as WorkspaceManager
}

// Every write-tool call needs `writePaths` populated — the tool refuses on
// empty scope before doing anything else. The specific value doesn't matter
// (nothing hits disk in these tests); the shape does.
const writableCtx: ToolContext = { repoPaths: {}, writePaths: ['/wt'] }

afterEach(() => {
  // Reset the module-level singleton between cases so a stub from one test
  // doesn't leak into the next (all tests share the process-wide registry).
  setWorkspaceManager(null)
})

describe('reset_worktree tool', () => {
  it('delegates to WorkspaceManager.resetWorktree and returns path + previous/new sha + reflog hint', async () => {
    const resetMock = mock(async (_taskId: string) => ({
      path: '/tmp/ia-flow/demo/.worktrees/task-1',
      previousSha: 'deadbeefcafefeed11111111111111111111aaaa',
      newSha: 'facadefacade22222222222222222222222222bb',
    }))
    setWorkspaceManager({ resetWorktree: resetMock } as unknown as WorkspaceManager)

    const tool = getTool('reset_worktree')
    expect(tool).toBeDefined()

    const out = await tool!.execute({ task_id: 'task-1' }, writableCtx)

    expect(resetMock).toHaveBeenCalledTimes(1)
    expect(resetMock.mock.calls[0][0]).toBe('task-1')
    expect(out).toContain('Worktree reseteado para task task-1')
    expect(out).toContain('/tmp/ia-flow/demo/.worktrees/task-1')
    // Both hashes must be surfaced so the agent can hand them to the human.
    expect(out).toContain('deadbeefcafefeed11111111111111111111aaaa')
    expect(out).toContain('facadefacade22222222222222222222222222bb')
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
    const resetMock = mock(async (_taskId: string) => ({
      path: '/tmp/wt/task-99',
      previousSha: '11111111',
      newSha: '22222222',
    }))
    setWorkspaceManager({ resetWorktree: resetMock } as unknown as WorkspaceManager)
    const tool = getTool('reset_worktree')!

    const out = await tool.execute({}, { ...writableCtx, taskId: 'task-99' })

    expect(resetMock).toHaveBeenCalledTimes(1)
    expect(resetMock.mock.calls[0][0]).toBe('task-99')
    expect(out).toContain('task task-99')
  })

  it('falls back to explicit hint strings when the manager returns null hashes', async () => {
    // `previousSha`/`newSha` may be null if the worktree did not exist
    // beforehand or rev-parse failed after the recreate. The tool must
    // not blank-out those slots — the operator relies on them to reason
    // about what happened.
    setWorkspaceManager(
      stubManager(async () => ({
        path: '/tmp/wt/task-nowt',
        previousSha: null,
        newSha: null,
      })),
    )
    const tool = getTool('reset_worktree')!
    const out = await tool.execute({ task_id: 'task-nowt' }, writableCtx)
    expect(out).toContain('sin worktree previo')
    expect(out).toContain('HEAD no resolvible')
  })

  it('refuses when writePaths is empty (mirrors write_file / edit_file guard)', async () => {
    // The message must contain the same stable substring that write/edit
    // emit, so an operator can grep for one string across all write tools.
    setWorkspaceManager(stubManager(async () => ({ path: '/x', previousSha: null, newSha: null })))
    const tool = getTool('reset_worktree')!
    const out = await tool.execute({ task_id: 'task-1' }, { repoPaths: {} })
    expect(out).toContain('escritura no permitida en fase actual')
  })

  it('surfaces manager errors as a tool-result string instead of throwing', async () => {
    setWorkspaceManager(
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
    setWorkspaceManager(null)
    const tool = getTool('reset_worktree')!
    const out = await tool.execute({ task_id: 'task-1' }, writableCtx)
    expect(out).toContain('unavailable')
    expect(out).toContain('WorkspaceManager')
  })

  it('rejects call when neither task_id nor ctx.taskId is present', async () => {
    setWorkspaceManager(stubManager(async () => ({ path: '/x', previousSha: null, newSha: null })))
    const tool = getTool('reset_worktree')!
    const out = await tool.execute({}, writableCtx)
    // The error must cite both fallbacks so an operator debugging a bad
    // provider knows where to look (ctx propagation vs input).
    expect(out).toContain('task_id')
    expect(out).toContain('ctx.taskId')
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
