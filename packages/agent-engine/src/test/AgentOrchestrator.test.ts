import { describe, expect, it, mock } from 'bun:test'
import type { IAgentProvider, ProviderInput } from '@ia-flow/ai-providers'
import { UpstreamAbortError } from '@ia-flow/ai-providers'
import type { ITaskSource } from '@ia-flow/issue-sources'
import type { Task } from '@ia-flow/shared'
import { AgentOrchestrator } from '../AgentOrchestrator.js'
import {
  type ShellResult,
  type ShellRunner,
  WorkspaceManager,
  worktreePathFor,
} from '../WorkspaceManager.js'
import type {
  IBroadcast,
  IExecutionLogRepository,
  IProjectConfigRepository,
  IProviderRegistry,
  IRepoRepository,
} from '../contract.js'
import { removePendingTask } from '../pending-tasks.js'

describe('AgentOrchestrator.runAgent — upstream abort handling', () => {
  function makeTask(): Task {
    return {
      id: 'task-abort-1',
      title: 't',
      description: '',
      type: 'technical',
      repos: [],
      status: 'InProgress',
      projectId: 'p1',
    } as unknown as Task
  }

  function makeDeps(providerError: Error) {
    const provider: IAgentProvider = {
      id: 'anthropic-api',
      kind: 'sync',
      name: 'test',
      description: '',
      run: async (_: ProviderInput) => {
        throw providerError
      },
    }
    const providers: IProviderRegistry = {
      get: (id: string) => (id === 'anthropic-api' ? provider : undefined),
    } as unknown as IProviderRegistry

    const configRepo: IProjectConfigRepository = {
      getConfig: async () => ({
        agents: [
          {
            id: 'implementer',
            provider: 'anthropic-api',
            prompt: 'x',
            tools: [],
            statusName: 'InProgress',
          },
        ],
        statuses: [{ name: 'InProgress' }],
      }),
    } as unknown as IProjectConfigRepository

    const repoRepo: IRepoRepository = {
      list: () => [],
      listByProject: () => [],
    } as unknown as IRepoRepository

    const setAgentWorking = mock(async (t: Task) => t)
    const postError = mock(async () => {})
    const manager: ITaskSource = {
      applyTransition: async (t: Task) => t,
      saveOutput: async (t: Task) => t,
      setAgentWorking,
      postError,
      getCurrentStatus: async () => 'InProgress',
    } as unknown as ITaskSource

    const update = mock(() => {})
    const executionLogRepo: IExecutionLogRepository = {
      insert: () => {},
      update,
      list: () => [],
      listActive: () => [],
      getById: () => null,
      sweepOrphaned: () => 0,
    }

    const orch = new AgentOrchestrator(
      providers,
      configRepo,
      repoRepo,
      { send: () => {} } as IBroadcast,
      undefined,
      executionLogRepo,
    )

    return { orch, manager, update, setAgentWorking }
  }

  // Regression: an AbortError thrown by the provider used to be swallowed by a
  // ReferenceError inside the catch block (`controller` was declared inside the
  // sibling try). That left execution_logs rows open forever and the task with
  // agent-working=true. This test locks the recovery path in place.
  it('marks execution_logs as cancelled and clears working on UpstreamAbortError', async () => {
    const err = new UpstreamAbortError(
      'Anthropic API upstream abort after 276000ms: The operation timed out',
    )
    const { orch, manager, update, setAgentWorking } = makeDeps(err)

    await orch.runAgent(makeTask(), manager)

    expect(update).toHaveBeenCalled()
    const patch = (update.mock.calls.at(-1) as unknown as unknown[])?.[1] as {
      finishedAt?: string
      outcome?: string
      errorMsg?: string
    }
    expect(patch.outcome).toBe('cancelled')
    expect(patch.finishedAt).toBeTruthy()
    expect(patch.errorMsg ?? '').toContain('upstream-abort')

    const clearedWorking = setAgentWorking.mock.calls.some(
      (c) => (c as unknown as unknown[])[1] === false,
    )
    expect(clearedWorking).toBe(true)
  })

  // A plain AbortError (name === 'AbortError') that is NOT an UpstreamAbortError
  // must go to the generic error path — outcome='error' — instead of being
  // silently treated as an operator cancel. Guards against the old
  // `err.name === 'AbortError'` heuristic sneaking back in.
  it('treats a plain AbortError as a real error, not an upstream-abort', async () => {
    const err = new Error('operation aborted')
    err.name = 'AbortError'
    const { orch, manager, update } = makeDeps(err)

    // Normal error path rethrows once execution_logs is updated.
    await expect(orch.runAgent(makeTask(), manager)).rejects.toThrow('operation aborted')

    const patch = (update.mock.calls.at(-1) as unknown as unknown[])?.[1] as {
      outcome?: string
      errorMsg?: string
    }
    expect(patch.outcome).toBe('error')
    expect(patch.errorMsg ?? '').not.toContain('upstream-abort')
  })
})

// ─── WorkspaceManager integration ────────────────────────────────────────
//
// End-to-end (in-process): a real `WorkspaceManager` wired with a stub
// `ShellRunner` so we can exercise `acquireTask` / `getOrCreateWorktree` /
// `resolveScopes` / `releaseTask` without touching disk or spawning git.
// The provider is a capturing stub that records what the orchestrator
// forwarded so we can assert the ToolContext handshake (repoPaths swap +
// writePaths propagation).

const REPO = '/repos/demo'

/**
 * Minimal `ShellRunner` that answers with successful exits for the git
 * commands the WorkspaceManager issues during a create-path
 * `getOrCreateWorktree`:
 *   • `git fetch origin` → ok
 *   • `git worktree list --porcelain` → main only (no reuse)
 *   • `git rev-parse --verify …` → exit 1 (branch doesn't pre-exist)
 *   • `git worktree add -b <branch> <path> origin/main` → ok
 * Any other command falls through to a benign `ok()` so the test isn't
 * brittle to future WorkspaceManager evolutions.
 */
function okShell(): ShellRunner {
  return {
    async run(args: string[]): Promise<ShellResult> {
      if (args[0] === 'git' && args[1] === 'worktree' && args[2] === 'list') {
        // Only the main worktree exists — force the create path.
        return { stdout: `worktree ${REPO}\n`, stderr: '', exitCode: 0 }
      }
      if (args[0] === 'git' && args[1] === 'rev-parse') {
        // Branch doesn't pre-exist → `git worktree add -b` path.
        return { stdout: '', stderr: '', exitCode: 1 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
  }
}

interface WsDeps {
  agentTools?: string[]
  workspaceManager: WorkspaceManager
  captureInput?: (input: ProviderInput) => void
}

function makeWsDeps(opts: WsDeps): { orch: AgentOrchestrator; manager: ITaskSource } {
  const provider: IAgentProvider = {
    id: 'anthropic-api',
    kind: 'sync',
    name: 'test',
    description: '',
    run: async (input: ProviderInput) => {
      opts.captureInput?.(input)
      return { content: 'ok', mode: 'api' }
    },
  }
  const providers: IProviderRegistry = {
    get: (id: string) => (id === 'anthropic-api' ? provider : undefined),
  } as unknown as IProviderRegistry

  const configRepo: IProjectConfigRepository = {
    getConfig: async () => ({
      agents: [
        {
          id: 'implementer',
          provider: 'anthropic-api',
          prompt: 'x',
          tools: opts.agentTools ?? [],
          statusName: 'InProgress',
        },
      ],
      statuses: [{ name: 'InProgress' }],
    }),
  } as unknown as IProjectConfigRepository

  const repoRepo: IRepoRepository = {
    list: () => [{ name: 'demo', path: REPO }],
    listByProject: () => [{ name: 'demo', path: REPO }],
  } as unknown as IRepoRepository

  const manager: ITaskSource = {
    applyTransition: async (t: Task) => t,
    saveOutput: async (t: Task) => t,
    setAgentWorking: async (t: Task, _working: boolean) => t,
    postError: async () => {},
    getCurrentStatus: async (t: Task) => t.status,
  } as unknown as ITaskSource

  const orch = new AgentOrchestrator(
    providers,
    configRepo,
    repoRepo,
    { send: () => {} } as IBroadcast,
    undefined, // mcpCatalogRepo
    undefined, // executionLogRepo
    opts.workspaceManager,
  )
  return { orch, manager }
}

function makeWsTask(id: string): Task {
  return {
    id,
    title: 'ws',
    description: '',
    type: 'technical',
    repos: ['demo'],
    status: 'InProgress',
    projectId: 'p1',
  } as unknown as Task
}

describe('AgentOrchestrator — WorkspaceManager integration', () => {
  // Unique base per describe run so parallel tests never share a #taskLocks
  // key on the same in-memory WorkspaceManager instance (each `it` builds
  // its own manager anyway, but keeping the base distinct also guards
  // against filesystem existsSync races if a future refactor turns those
  // paths real).
  const BASE = `/tmp/ia-flow-integration-${Date.now()}`

  it('read-only agent → primary repoPath stays the base repo, writePaths is empty', async () => {
    const wsm = new WorkspaceManager(okShell(), { worktreeBase: BASE })
    let captured: ProviderInput | undefined
    const { orch, manager } = makeWsDeps({
      agentTools: ['read_file'],
      workspaceManager: wsm,
      captureInput: (inp) => {
        captured = inp
      },
    })

    await orch.runAgent(makeWsTask('PVTI_ws_read'), manager)

    expect(captured).toBeDefined()
    // No worktree materialized (read-only), so resolveScopes returns the base
    // repo path as the read root and no write scope.
    expect(captured!.repoPaths.demo).toBe(REPO)
    expect(captured!.writePaths ?? []).toEqual([])
  })

  it('write agent → primary repoPath is swapped to the worktree, writePaths mirrors it', async () => {
    const wsm = new WorkspaceManager(okShell(), { worktreeBase: BASE })
    let captured: ProviderInput | undefined
    const { orch, manager } = makeWsDeps({
      agentTools: ['fs_write'],
      workspaceManager: wsm,
      captureInput: (inp) => {
        captured = inp
      },
    })

    const TASK_ID = 'PVTI_ws_write'
    await orch.runAgent(makeWsTask(TASK_ID), manager)

    const wt = worktreePathFor(REPO, TASK_ID, BASE)
    expect(captured!.repoPaths.demo).toBe(wt)
    expect(captured!.writePaths).toEqual([wt])
  })

  it('per-task mutex: a second runAgent while the lock is held throws "task <id> ya está corriendo"', async () => {
    const wsm = new WorkspaceManager(okShell(), { worktreeBase: BASE })
    const TASK_ID = 'PVTI_ws_locked'

    // Simulate a run already in-flight by grabbing the lock outside the
    // orchestrator — same primitive the orchestrator uses internally.
    wsm.acquireTask(TASK_ID, REPO)
    try {
      const { orch, manager } = makeWsDeps({
        agentTools: ['read_file'],
        workspaceManager: wsm,
      })
      await expect(orch.runAgent(makeWsTask(TASK_ID), manager)).rejects.toThrow(
        `task ${TASK_ID} ya está corriendo`,
      )
    } finally {
      // Never leak the lock — otherwise a follow-up test on the same manager
      // instance would inherit the "locked" state.
      wsm.releaseTask(TASK_ID)
    }
  })

  it('releases the lock in `finally` so a follow-up runAgent on the same task succeeds', async () => {
    const wsm = new WorkspaceManager(okShell(), { worktreeBase: BASE })
    const TASK_ID = 'PVTI_ws_sequential'
    const { orch, manager } = makeWsDeps({
      agentTools: ['read_file'],
      workspaceManager: wsm,
    })

    // First run completes → releaseTask fires in `finally`.
    await orch.runAgent(makeWsTask(TASK_ID), manager)
    // Second run must not throw "ya está corriendo".
    await orch.runAgent(makeWsTask(TASK_ID), manager)
  })
})

// ─── Terminal worktree auto-cleanup ──────────────────────────────────────────
//
// Verifies that AgentOrchestrator removes the worktree in the `finally` block
// when a terminal (tmux) agent ran with workflow=worktree and the worktree is
// clean.  Uses ShellRunner stubs to control `isWorktreeSafeToRemove` output
// without touching disk or spawning real git.

const CLEANUP_REPO = '/repos/cleanup-demo'

/**
 * ShellRunner for terminal worktree cleanup tests.
 * Controls `git status --porcelain` and `git log` output via `opts`.
 * All other git commands (worktree remove, branch -D, ls-remote, log) return
 * success with empty stdout so WorkspaceManager.removeWorktree completes.
 */
function makeCleanupShell(opts: {
  dirty: boolean
  /** If provided, ls-remote returns exit 0 and log origin/branch..HEAD returns
   *  this stdout (empty = no ahead commits). If undefined, ls-remote exits 2
   *  (branch absent) and log origin/HEAD..HEAD is used instead. */
  remoteAheadOut?: string
}): ShellRunner & { removeCalls: string[][] } {
  const shell = {
    removeCalls: [] as string[][],
    async run(args: string[]): Promise<ShellResult> {
      // git status --porcelain
      if (args[1] === 'status' && args[2] === '--porcelain') {
        return { stdout: opts.dirty ? 'M file.ts\n' : '', stderr: '', exitCode: 0 }
      }
      // git ls-remote --exit-code origin refs/heads/<branch>
      if (args[1] === 'ls-remote' && args[2] === '--exit-code') {
        if (opts.remoteAheadOut !== undefined) {
          // Remote branch exists
          return { stdout: 'abc123\trefs/heads/task/x\n', stderr: '', exitCode: 0 }
        }
        // Remote branch absent → exit 2
        return { stdout: '', stderr: '', exitCode: 2 }
      }
      // git log ... (both origin/HEAD..HEAD and origin/<branch>..HEAD)
      if (args[1] === 'log' && args[2] === '--oneline') {
        return { stdout: opts.remoteAheadOut ?? '', stderr: '', exitCode: 0 }
      }
      // worktree list (needed by WorkspaceManager internal checks)
      if (args[1] === 'worktree' && args[2] === 'list') {
        return { stdout: `worktree ${CLEANUP_REPO}\n`, stderr: '', exitCode: 0 }
      }
      // Track remove / branch -D calls
      if (args[1] === 'worktree' && args[2] === 'remove') {
        shell.removeCalls.push(args)
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      if (args[1] === 'branch' && args[2] === '-D') {
        shell.removeCalls.push(args)
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    },
  }
  return shell
}

/**
 * Builds an orchestrator + manager whose agent is a terminal (tmux) provider.
 * `runnerOpts` controls the ShellRunner behaviour for the safety check.
 * The provider immediately resolves the waitForFinish promise via a microtask
 * calling `removePendingTask` so the test doesn't hang.
 */
function makeTerminalWsDeps(opts: {
  runnerOpts: Parameters<typeof makeCleanupShell>[0]
  workflow?: 'worktree' | 'branch' | 'main'
  branch?: string
}): {
  orch: AgentOrchestrator
  manager: ITaskSource
  shell: ReturnType<typeof makeCleanupShell>
} {
  const shell = makeCleanupShell(opts.runnerOpts)
  const wsm = new WorkspaceManager(shell, { worktreeBase: '/tmp/ia-flow-cleanup-test' })

  const taskId = 'PVTI_cleanup_test'

  // Terminal-style provider (mode: 'tmux'): resolve the waitForFinish promise
  // asynchronously right after the provider.run() call returns, mimicking
  // what complete_task / fail_task tools do in production.
  const provider: IAgentProvider = {
    id: 'tmux-claude',
    kind: 'async',
    name: 'test-terminal',
    description: '',
    run: async (_input: ProviderInput) => {
      // Schedule resolution of the pending-task promise AFTER registerPendingTask
      // fires (which happens in the orchestrator right after this call returns).
      Promise.resolve().then(() => {
        removePendingTask(taskId)
      })
      return { content: '', mode: 'tmux' }
    },
  }

  const providers: IProviderRegistry = {
    get: () => provider,
  } as unknown as IProviderRegistry

  const configRepo: IProjectConfigRepository = {
    getConfig: async () => ({
      agents: [
        {
          id: 'implementer',
          provider: 'tmux-claude',
          prompt: 'x',
          tools: ['fs_write'],
          statusName: 'InProgress',
        },
      ],
      statuses: [{ name: 'InProgress' }],
    }),
  } as unknown as IProjectConfigRepository

  const repoRepo: IRepoRepository = {
    list: () => [
      { name: 'cleanup-demo', path: CLEANUP_REPO, workflow: opts.workflow ?? 'worktree' },
    ],
    listByProject: () => [
      { name: 'cleanup-demo', path: CLEANUP_REPO, workflow: opts.workflow ?? 'worktree' },
    ],
  } as unknown as IRepoRepository

  const manager: ITaskSource = {
    applyTransition: async (t: Task) => t,
    saveOutput: async (t: Task) => t,
    setAgentWorking: async (t: Task, _working: boolean) => t,
    postError: async () => {},
    getCurrentStatus: async (t: Task) => t.status,
  } as unknown as ITaskSource

  const orch = new AgentOrchestrator(
    providers,
    configRepo,
    repoRepo,
    { send: () => {} } as IBroadcast,
    undefined,
    undefined,
    wsm,
  )

  return { orch, manager, shell }
}

function makeCleanupTask(branch?: string): Task {
  return {
    id: 'PVTI_cleanup_test',
    title: 'cleanup',
    description: '',
    type: 'technical',
    repos: ['cleanup-demo'],
    status: 'InProgress',
    projectId: 'p1',
    branch: branch ?? 'task/PVTI_cleanup_test',
  } as unknown as Task
}

describe('AgentOrchestrator — terminal worktree auto-cleanup', () => {
  it('happy path: clean worktree → calls removeWorktree (git worktree remove + branch -D)', async () => {
    const { orch, manager, shell } = makeTerminalWsDeps({
      runnerOpts: { dirty: false, remoteAheadOut: '' },
    })

    await orch.runAgent(makeCleanupTask(), manager)

    // WorkspaceManager.removeWorktree issues `git worktree remove --force` and
    // `git branch -D <branch>` — we track both via shell.removeCalls.
    const removedWt = shell.removeCalls.some((c) => c[2] === 'remove')
    const deletedBranch = shell.removeCalls.some((c) => c[2] === '-D')
    expect(removedWt).toBe(true)
    expect(deletedBranch).toBe(true)
  })

  it('dirty worktree → skips removeWorktree, no git worktree remove called', async () => {
    const { orch, manager, shell } = makeTerminalWsDeps({
      runnerOpts: { dirty: true },
    })

    await orch.runAgent(makeCleanupTask(), manager)

    const anyRemoveCall = shell.removeCalls.some((c) => c[2] === 'remove')
    expect(anyRemoveCall).toBe(false)
  })

  it('workflow !== worktree → never calls removeWorktree', async () => {
    const { orch, manager, shell } = makeTerminalWsDeps({
      runnerOpts: { dirty: false, remoteAheadOut: '' },
      workflow: 'branch',
    })

    await orch.runAgent(makeCleanupTask(), manager)

    expect(shell.removeCalls.length).toBe(0)
  })
})

// ─── clone-on-missing-path ────────────────────────────────────────────────
//
// A repo registered with githubOwner/githubRepo but no local `path` yet
// (never cloned) should get cloned by WorkspaceManager before the run, and
// the resulting path persisted back via `repoRepo.upsert` so the next
// dispatch finds it already there.

const CLONE_REPO_NAME = 'no-path-yet'

describe('AgentOrchestrator — clones the repo when it has no local path', () => {
  it('clones via WorkspaceManager, persists the path, and runs the agent against it', async () => {
    const clonedBase = `/tmp/ia-flow-clone-orch-${Date.now()}`
    const clonedPath = `${clonedBase}/acme/${CLONE_REPO_NAME}`
    const shell: ShellRunner = {
      async run(args: string[]): Promise<ShellResult> {
        if (args[0] === 'git' && args[1] === 'clone') return { stdout: '', stderr: '', exitCode: 0 }
        if (args[0] === 'git' && args[1] === 'config')
          return { stdout: '', stderr: '', exitCode: 0 }
        if (args[0] === 'git' && args[1] === 'worktree' && args[2] === 'list') {
          return { stdout: `worktree ${clonedPath}\n`, stderr: '', exitCode: 0 }
        }
        if (args[0] === 'git' && args[1] === 'rev-parse') {
          return { stdout: '', stderr: '', exitCode: 1 }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      },
    }
    const wsm = new WorkspaceManager(shell, { worktreeBase: clonedBase, reposBase: clonedBase })

    const provider: IAgentProvider = {
      id: 'anthropic-api',
      kind: 'sync',
      name: 'test',
      description: '',
      run: async () => ({ content: 'ok', mode: 'api' }),
    }
    const providers: IProviderRegistry = {
      get: () => provider,
    } as unknown as IProviderRegistry

    const configRepo: IProjectConfigRepository = {
      getConfig: async () => ({
        agents: [
          {
            id: 'implementer',
            provider: 'anthropic-api',
            prompt: 'x',
            tools: ['read_file'],
            statusName: 'InProgress',
          },
        ],
        statuses: [{ name: 'InProgress' }],
      }),
    } as unknown as IProjectConfigRepository

    const noPathRepo = {
      name: CLONE_REPO_NAME,
      projectId: 'p1',
      githubOwner: 'acme',
      githubRepo: CLONE_REPO_NAME,
    }
    const upsertCalls: unknown[] = []
    const repoRepo: IRepoRepository = {
      list: () => [noPathRepo],
      listByProject: () => [noPathRepo],
      upsert: (entry: unknown) => {
        upsertCalls.push(entry)
      },
    } as unknown as IRepoRepository

    const manager: ITaskSource = {
      applyTransition: async (t: Task) => t,
      saveOutput: async (t: Task) => t,
      setAgentWorking: async (t: Task, _working: boolean) => t,
      postError: async () => {},
      getCurrentStatus: async (t: Task) => t.status,
    } as unknown as ITaskSource

    const orch = new AgentOrchestrator(
      providers,
      configRepo,
      repoRepo,
      { send: () => {} } as IBroadcast,
      undefined,
      undefined,
      wsm,
    )

    const task = {
      id: 'PVTI_clone_test',
      title: 'clone-me',
      description: '',
      type: 'technical',
      repos: [CLONE_REPO_NAME],
      status: 'InProgress',
      projectId: 'p1',
    } as unknown as Task

    const ok = await orch.runAgent(task, manager)

    expect(ok).toBe(true)
    expect(upsertCalls).toEqual([{ ...noPathRepo, path: clonedPath }])
  })
})
