import { describe, expect, it } from 'bun:test'
import type { AgentDefinition } from '@ia-flow/shared'
import { repoNameError } from '../agents-crud-validation.js'

// Pure validation rule — see agents-crud-validation.ts for why it takes
// `validRepoNames` instead of a repo port directly (keeps it testable
// without a DB and without dragging in composition/container.js, which
// opens a real SQLite connection as a side effect of being imported).
const baseAgent: AgentDefinition = {
  id: 'implementer',
  provider: 'anthropic',
  prompt: 'do it',
}

describe('repoNameError', () => {
  it('passes when repoName is unset', () => {
    expect(repoNameError(baseAgent, new Set())).toBeNull()
  })

  it('passes when the agent has no projectId (global agents cannot scope repoName)', () => {
    const agent = { ...baseAgent, repoName: 'backend', projectId: null }
    expect(repoNameError(agent, new Set(['backend']))).toBeNull()
  })

  it('passes when repoName exists among the project repos', () => {
    const agent = { ...baseAgent, repoName: 'backend', projectId: 'p1' }
    expect(repoNameError(agent, new Set(['backend', 'frontend']))).toBeNull()
  })

  it('fails with a clear message when repoName does not exist in the project', () => {
    const agent = { ...baseAgent, repoName: 'ghost', projectId: 'p1' }
    const err = repoNameError(agent, new Set(['backend']))
    expect(err).toContain("repoName 'ghost'")
    expect(err).toContain("project 'p1'")
  })
})
