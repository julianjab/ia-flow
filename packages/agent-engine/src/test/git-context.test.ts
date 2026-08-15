import { describe, expect, it } from 'bun:test'
import { buildGitContext } from './git-context.js'

// resolveBaseBranch hace shell git calls — usamos process.cwd() (este repo)
// que sabemos es un git repo con base branch main.

describe('buildGitContext — anthropic-api', () => {
  it('with worktreePath → menciona branch task/<id>, worktree path y PR', async () => {
    const out = await buildGitContext({
      taskId: 'ABC1',
      provider: 'anthropic-api',
      cwd: process.cwd(),
      worktreePath: '/tmp/ia-flow/foo/.worktrees/ABC1',
      hasWriteAccess: true,
    })
    expect(out).toContain('anthropic-api')
    expect(out).toContain('task/ABC1')
    expect(out).toContain('/tmp/ia-flow/foo/.worktrees/ABC1')
    expect(out).toContain('PR')
  })

  it('read-only (sin worktreePath, hasWriteAccess=false) → no push/PR, apunta al base repo', async () => {
    const out = await buildGitContext({
      taskId: 'ABC2',
      provider: 'anthropic-api',
      cwd: process.cwd(),
      hasWriteAccess: false,
    })
    expect(out).toContain('read-only')
    expect(out).toContain(process.cwd())
    expect(out).not.toMatch(/push .*PR/)
  })

  it('sin cwd → string vacío', async () => {
    expect(await buildGitContext({ taskId: 'X', provider: 'anthropic-api' })).toBe('')
  })
})

describe('buildGitContext — terminal', () => {
  it('workflow=main → menciona commit directly, no branch', async () => {
    const out = await buildGitContext({
      taskId: 'M1',
      provider: 'terminal',
      cwd: process.cwd(),
      workflow: 'main',
    })
    expect(out).toContain('Workflow: **main**')
    expect(out).not.toContain('task/M1')
  })

  it('workflow=branch → task/<id> + push/PR', async () => {
    const out = await buildGitContext({
      taskId: 'B1',
      provider: 'terminal',
      cwd: process.cwd(),
      workflow: 'branch',
    })
    expect(out).toContain('Workflow: **branch**')
    expect(out).toContain('task/B1')
    expect(out).toContain('push')
  })

  it('workflow=worktree → --worktree task/<id>', async () => {
    const out = await buildGitContext({
      taskId: 'W1',
      provider: 'terminal',
      cwd: process.cwd(),
      workflow: 'worktree',
    })
    expect(out).toContain('Workflow: **worktree**')
    expect(out).toContain('--worktree task/W1')
  })

  it('sin cwd → string vacío', async () => {
    expect(await buildGitContext({ taskId: 'X', provider: 'terminal', workflow: 'branch' })).toBe(
      '',
    )
  })
})
