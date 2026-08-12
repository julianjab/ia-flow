import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { WorkspaceManager } from '../application/WorkspaceManager.js'
import { getTool } from './index.js'
// Side-effect import — registers `reset_worktree` in the global tool registry.
import './workspace.js'
import { setWorkspaceManager } from './workspace.js'

// Minimal duck-typed stub cast as WorkspaceManager. The tool only calls
// `resetWorktree`, so we don't need to fake the full public surface.
function stubManager(behaviour: (taskId: string) => Promise<string>): WorkspaceManager {
  return { resetWorktree: behaviour } as unknown as WorkspaceManager
}

afterEach(() => {
  // Reset the module-level singleton between cases so a stub from one test
  // doesn't leak into the next (all tests share the process-wide registry).
  setWorkspaceManager(null)
})

describe('reset_worktree tool', () => {
  it('delegates to WorkspaceManager.resetWorktree and returns the new path + reflog hint', async () => {
    const resetMock = mock(async (_taskId: string) => '/tmp/ia-flow/demo/.worktrees/task-1')
    setWorkspaceManager({ resetWorktree: resetMock } as unknown as WorkspaceManager)

    const tool = getTool('reset_worktree')
    expect(tool).toBeDefined()

    const out = await tool!.execute({ task_id: 'task-1' }, { repoPaths: {} })

    expect(resetMock).toHaveBeenCalledTimes(1)
    expect(resetMock.mock.calls[0][0]).toBe('task-1')
    expect(out).toContain('Worktree reseteado para task task-1')
    expect(out).toContain('/tmp/ia-flow/demo/.worktrees/task-1')
    // Rescue path must be echoed so the agent can hand it back to the operator.
    expect(out).toContain('reflog')
  })

  it('surfaces manager errors as a tool-result string instead of throwing', async () => {
    setWorkspaceManager(
      stubManager(async () => {
        throw new Error('git fetch origin failed: network down')
      }),
    )
    const tool = getTool('reset_worktree')!
    const out = await tool.execute({ task_id: 'task-1' }, { repoPaths: {} })
    expect(out).toContain('reset_worktree failed:')
    expect(out).toContain('network down')
  })

  it('returns explicit "unavailable" error when WorkspaceManager is not wired', async () => {
    setWorkspaceManager(null)
    const tool = getTool('reset_worktree')!
    const out = await tool.execute({ task_id: 'task-1' }, { repoPaths: {} })
    expect(out).toContain('unavailable')
    expect(out).toContain('WorkspaceManager')
  })

  it('rejects call without task_id', async () => {
    setWorkspaceManager(stubManager(async () => '/x'))
    const tool = getTool('reset_worktree')!
    const out = await tool.execute({}, { repoPaths: {} })
    expect(out).toContain('task_id es requerido')
  })

  it('is restricted to sync providers (excluded from async curl appendix)', () => {
    const tool = getTool('reset_worktree')!
    // Only anthropic-api (sync) builds the WorkspaceManager sandbox. Terminal
    // providers (tmux/iterm) have no worktree to reset, so declaring
    // `providerKinds: ['sync']` keeps the tool out of `buildToolInstructions`
    // and out of the API tool list for async providers.
    expect(tool.providerKinds).toEqual(['sync'])
  })
})
