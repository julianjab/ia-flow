import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Capabilities,
  createEvent,
  EventBus,
  FunctionAction,
  type PipelineExecutionContext,
} from '@ia-flow/agent-engine'
import { describe, expect, it, vi } from 'vitest'
import {
  CleanupWorkspaceAction,
  WorkspaceSession,
  type WorkspaceTarget,
  workspaceAction,
} from '../actions/index.js'
import type { WorkspaceManager } from '../WorkspaceManager.js'

const dir = mkdtempSync(join(tmpdir(), 'ws-actions-'))
writeFileSync(join(dir, 'a.txt'), 'hola\n')
writeFileSync(join(dir, 'big.txt'), 'x'.repeat(20_000))

const target: WorkspaceTarget = {
  task: { id: 'o/r#7', issueNumber: 7 },
  repo: { name: 'r', githubOwner: 'o', githubRepo: 'r' },
  branch: 'ia-flow/7',
}

/** Un manager de mentira: registra qué le piden y devuelve `dir`. */
function fakeManager() {
  return {
    ensureLocalClone: vi.fn(async () => '/repos/o/r'),
    getOrCreateWorktree: vi.fn(async () => ({ path: dir, branch: 'ia-flow/7' })),
    cleanupTerminalWorktree: vi.fn(async () => {}),
  }
}

const run = (): PipelineExecutionContext => ({
  event: createEvent('pull_request', {}),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'review',
})

function session(manager = fakeManager()) {
  return {
    manager,
    session: new WorkspaceSession(manager as unknown as WorkspaceManager, () => target),
  }
}

describe('WorkspaceSession', () => {
  it('prepares the worktree once per run, through the manager', async () => {
    const { manager, session: s } = session()
    const ctx = run()
    expect(await s.dirFor(ctx)).toBe(dir)
    await s.dirFor(ctx)
    expect(manager.ensureLocalClone).toHaveBeenCalledTimes(1)
    expect(manager.getOrCreateWorktree).toHaveBeenCalledWith(target.task, '/repos/o/r', {
      branch: 'ia-flow/7',
    })
    await s.dirFor(run())
    expect(manager.getOrCreateWorktree).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failure: the next call retries', async () => {
    const manager = fakeManager()
    manager.ensureLocalClone.mockRejectedValueOnce(new Error('red caída'))
    const { session: s } = session(manager)
    const ctx = run()
    await expect(s.dirFor(ctx)).rejects.toThrow('red caída')
    expect(await s.dirFor(ctx)).toBe(dir)
  })
})

describe('workspaceAction', () => {
  it('runs the real fs tool over the run worktree, under the same name', async () => {
    const { session: s } = session()
    const read = workspaceAction('fs_read', s)
    expect(read).toMatchObject({ id: 'fs_read', sideEffects: 'none' })
    expect(await read.run(run(), { path: 'a.txt' })).toContain('hola')
  })

  it('fs_read focuses a big file with the fileFocus capability of the run', async () => {
    const { session: s } = session()
    const read = workspaceAction('fs_read', s)
    const seen: unknown[] = []
    const capabilities = new Capabilities(
      {
        fileFocus: new FunctionAction({
          fn: (ctx) => {
            seen.push(ctx.event.payload)
            return { text: '## lines 1-1\nxxx' }
          },
        }),
      },
      new EventBus(),
    )

    const result = await read.asTool({ ...run(), capabilities }).handler({
      path: 'big.txt',
      focus: 'el principio',
    })

    expect(result).toMatch(/## lines 1-1\nxxx$/)
    expect(seen).toMatchObject([{ path: 'big.txt', focus: 'el principio' }])
  })

  it('bash_run writes, and enforces the policy it was given', async () => {
    const { session: s } = session()
    const bash = workspaceAction('bash_run', s, { allow: ['git status *'], deny: [] })
    expect(bash.sideEffects).toBe('write')
    await expect(bash.run(run(), { command: 'git fetch origin' })).rejects.toThrow()
  })

  it('hands bash_run the git credential it was given (network git only)', async () => {
    const { session: s } = session()
    const credential = vi.fn(async () => 'tok')
    const bash = workspaceAction('bash_run', s, { deny: [] }, { gitCredential: credential })
    // `git ls-remote` contra un remote inexistente falla, pero antes pide la credencial.
    await bash.run(run(), { command: 'git ls-remote nope' })
    expect(credential).toHaveBeenCalled()
    await bash.run(run(), { command: 'git status' })
    expect(credential).toHaveBeenCalledTimes(1)
  })

  it('rejects names that are not disk tools', () => {
    expect(() => workspaceAction('review_pull_request', session().session)).toThrow(
      /no es una tool de disco/,
    )
  })
})

describe('CleanupWorkspaceAction', () => {
  it('does nothing when no tool asked for a workspace in the run', async () => {
    const { manager, session: s } = session()
    expect(await new CleanupWorkspaceAction(s).run(run(), {})).toMatch(/nada que limpiar/)
    expect(manager.cleanupTerminalWorktree).not.toHaveBeenCalled()
  })

  it("hands the run's worktree to the manager's guarded cleanup", async () => {
    const { manager, session: s } = session()
    const ctx = run()
    await s.dirFor(ctx)
    await new CleanupWorkspaceAction(s).run(ctx, {})
    expect(manager.cleanupTerminalWorktree).toHaveBeenCalledWith(
      target.task,
      '/repos/o/r',
      'ia-flow/7',
      dir,
    )
  })
})
