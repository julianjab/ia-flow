/** La única pieza del workspace que es de la app: evento → `WorkspaceTarget`. El ciclo de vida
 *  (clone, worktree, sync) se prueba en `@ia-tools/workspace`. */

import { describe, expect, it } from 'bun:test'
import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-tools/agent-engine'
import { workspaceTargetFor } from '../workspace.js'

const ctx = (payload: Record<string, unknown>): PipelineExecutionContext => ({
  event: createEvent('pull_request', payload),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'review',
})

const base = {
  owner: 'la-haus',
  repo: 'subscriptions',
  number: 7,
  task: { id: 'la-haus/subscriptions#7', title: 'paginar leads', branch: 'ia-flow-local/7' },
}

describe('workspaceTargetFor', () => {
  it('names the worktree after the task and clones its repo', () => {
    expect(workspaceTargetFor(ctx(base))).toEqual({
      task: { id: 'la-haus/subscriptions#7', issueNumber: 7, title: 'paginar leads' },
      repo: { name: 'subscriptions', githubOwner: 'la-haus', githubRepo: 'subscriptions' },
      branch: 'ia-flow-local/7',
    })
  })

  it("prefers the PR's own branch — a PR opened by hand is reviewed on its branch", () => {
    expect(workspaceTargetFor(ctx({ ...base, pr: { head: { ref: 'feat/humano' } } })).branch).toBe(
      'feat/humano',
    )
  })

  it('refuses an event that does not say what to check out', () => {
    expect(() => workspaceTargetFor(ctx({ owner: 'o', repo: 'r' }))).toThrow(
      /qué task, repo y branch/,
    )
  })
})
