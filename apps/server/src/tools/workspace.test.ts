import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { ResetWorktreeResult, WorkspaceManager } from '../application/WorkspaceManager.js'
import type { ToolContext } from './index.js'
import { getTool } from './index.js'
// Side-effect import — registers `reset_worktree` in the global tool registry.
import './workspace.js'
import { setWorkspaceManager } from './workspace.js'

// Minimal duck-typed stub cast as WorkspaceManager. The tool only calls
// `resetWorktree`, so we don't need to fake the full public surface.
function stubManager(
  behaviour: (taskId: string) => Promise<ResetWorktreeResult>,
): WorkspaceManager {
  return { resetWorktree: behaviour } as unknown as WorkspaceManager
}

// Reused ctx shape for the happy path. Individual cases override fields.
const WRITE_CTX: ToolContext = { repoPaths: {}, writePaths: ['/tmp/wt'] }

afterEach(() => {
  // Reset the module-level singleton between cases so a stub from one test
  // doesn't leak into the next (all tests share the process-wide registry).
  setWorkspaceManager(null)
})

describe('reset_worktree tool', () => {
  it('delegates to WorkspaceManager.resetWorktree and echoes both HEAD hashes + reflog hint', async () => {
    const resetMock = mock(
      async (_taskId: string): Promise<ResetWorktreeResult> => ({
        path: '/tmp/ia-flow/demo/.worktrees/task-1',
        previousHead: 'deadbeef1234567',
        newHead: 'cafef00d9876543',
      }),
    )
    setWorkspaceManager({ resetWorktree: resetMock } as unknown as WorkspaceManager)

    const tool = getTool('reset_worktree')
    expect(tool).toBeDefined()

    const out = await tool!.execute({ task_id: 'task-1' }, WRITE_CTX)

    expect(resetMock).toHaveBeenCalledTimes(1)
    expect(resetMock.mock.calls[0][0]).toBe('task-1')
    expect(out).toContain('Worktree reseteado para task task-1')
    expect(out).toContain('/tmp/ia-flow/demo/.worktrees/task-1')
    expect(out).toContain('deadbeef1234567') // previous HEAD
    expect(out).toContain('cafef00d9876543') // new HEAD
    // Rescue path must be echoed so the agent can hand it back to the operator.
    expect(out).toContain('reflog')
    expect(out).toContain('task/task-1')
  })

  it('accepts empty input `{}` and resolves taskId from ctx.taskId', async () => {
    const resetMock = mock(
      async (taskId: string): Promise<ResetWorktreeResult> => ({
        path: `/tmp/wt/${taskId}`,
        previousHead: null,
        newHead: 'abc123',
      }),
    )
    setWorkspaceManager({ resetWorktree: resetMock } as unknown as WorkspaceManager)

    const tool = getTool('reset_worktree')!
    const out = await tool.execute({}, { ...WRITE_CTX, taskId: 'task-42' })

    expect(resetMock).toHaveBeenCalledWith('task-42')
    expect(out).toContain('task-42')
    // previousHead=null renders as an explicit sentinel so the agent doesn't
    // hallucinate a SHA.
    expect(out).toContain('no había HEAD previo')
  })

  it('rejects when writePaths is empty (shared guard with run_command)', async () => {
    const resetMock = mock(async () => ({
      path: '/x',
      previousHead: null,
      newHead: 'y',
    }))
    setWorkspaceManager({ resetWorktree: resetMock } as unknown as WorkspaceManager)

    const tool = getTool('reset_worktree')!
    const out = await tool.execute(
      { task_id: 'task-1' },
      { repoPaths: {}, writePaths: [], taskId: 'task-1' },
    )
    expect(out).toContain('escritura no permitida en fase actual')
    // Guard must trip *before* the manager is consulted — otherwise a
    // read-only phase could still mutate the worktree.
    expect(resetMock).not.toHaveBeenCalled()
  })

  it('rejects when writePaths is undefined', async () => {
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
    const out = await tool.execute({ task_id: 'task-1' }, WRITE_CTX)
    expect(out).toContain('reset_worktree failed:')
    expect(out).toContain('network down')
  })

  it('returns explicit "unavailable" error when WorkspaceManager is not wired', async () => {
    setWorkspaceManager(null)
    const tool = getTool('reset_worktree')!
    const out = await tool.execute({ task_id: 'task-1' }, WRITE_CTX)
    expect(out).toContain('unavailable')
    expect(out).toContain('WorkspaceManager')
  })

  it('rejects call without task_id nor ctx.taskId', async () => {
    setWorkspaceManager(
      stubManager(async () => ({ path: '/x', previousHead: null, newHead: 'y' })),
    )
    const tool = getTool('reset_worktree')!
    const out = await tool.execute({}, WRITE_CTX)
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
