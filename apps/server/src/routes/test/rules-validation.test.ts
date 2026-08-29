import { describe, expect, it } from 'bun:test'
import type { Rule } from '@ia-flow/shared'
import { repoNameError } from '../rules-validation.js'

// Pure validation rule — see rules-validation.ts for why it takes
// `validRepoNames` instead of a repo port directly (keeps it testable
// without a DB and without dragging in composition/container.js, which
// opens a real SQLite connection as a side effect of being imported).
const baseRule: Rule = {
  id: 'implementer',
  on: ['issue.scanned'],
  do: [{ action: 'agent', agentId: 'implementer' }],
}

describe('repoNameError', () => {
  it('passes when repoName is unset', () => {
    expect(repoNameError(baseRule, new Set())).toBeNull()
  })

  it('passes when la regla no tiene projectId (una regla global no puede scopear repoName)', () => {
    const agent = { ...baseRule, repoName: 'backend', projectId: null }
    expect(repoNameError(agent, new Set(['backend']))).toBeNull()
  })

  it('passes when repoName exists among the project repos', () => {
    const agent = { ...baseRule, repoName: 'backend', projectId: 'p1' }
    expect(repoNameError(agent, new Set(['backend', 'frontend']))).toBeNull()
  })

  it('fails with a clear message when repoName does not exist in the project', () => {
    const rule = { ...baseRule, repoName: 'ghost', projectId: 'p1' }
    const err = repoNameError(rule, new Set(['backend']))
    expect(err).toContain("repoName 'ghost'")
    expect(err).toContain("proyecto 'p1'")
  })
})
