import { describe, expect, it } from 'bun:test'
import { issueRef } from './issue-ref.js'

describe('issueRef', () => {
  it('arma owner/repo#N con lo que los sources de GitHub ya publican en meta', () => {
    expect(
      issueRef({
        id: 'PVTI_lADOAy2Wus4BhjDSzg4Lqz0',
        meta: { owner: 'julianjab', repoName: 'ia-flow', issueNumber: 42 },
      }),
    ).toBe('julianjab/ia-flow#42')
  })

  it('sin owner usa sólo el repo', () => {
    expect(issueRef({ id: 'x', meta: { repoName: 'ia-flow', issueNumber: 7 } })).toBe('ia-flow#7')
  })

  it('sin repo ni owner deja el número solo', () => {
    expect(issueRef({ id: 'x', meta: { issueNumber: 7 } })).toBe('#7')
  })

  it('sin issueNumber cae al id nativo — local-fs no tiene número de issue', () => {
    expect(issueRef({ id: 'task-123', meta: { repoName: 'ia-flow' } })).toBe('task-123')
  })

  it('sin meta cae al id', () => {
    expect(issueRef({ id: 'task-123' })).toBe('task-123')
  })
})
