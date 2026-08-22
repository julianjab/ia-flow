import { describe, expect, test } from 'bun:test'
import {
  isUnsupportedPullRequestFieldError,
  issueDevLinksSelection,
  mapDevLinks,
  pickPrimaryBranch,
} from '../dev-links.js'

describe('pickPrimaryBranch', () => {
  test('prefers the branch that belongs to the primary repo', () => {
    const nodes = [
      { ref: { name: 'other/branch', repository: { name: 'otro-repo' } } },
      { ref: { name: 'fix/aca', repository: { name: 'ia-flow' } } },
    ]
    expect(pickPrimaryBranch(nodes, 'ia-flow')).toBe('fix/aca')
  })

  test('falls back to the first branch when none matches the repo', () => {
    const nodes = [{ ref: { name: 'other/branch', repository: { name: 'otro-repo' } } }]
    expect(pickPrimaryBranch(nodes, 'ia-flow')).toBe('other/branch')
  })

  test('undefined when there are no linked branches', () => {
    expect(pickPrimaryBranch([], 'ia-flow')).toBeUndefined()
    expect(pickPrimaryBranch(undefined, 'ia-flow')).toBeUndefined()
  })
})

describe('mapDevLinks', () => {
  test('collapses a merged PR into state "merged"', () => {
    const links = mapDevLinks(
      {
        linkedBranches: { nodes: [] },
        closedByPullRequestsReferences: {
          nodes: [
            { number: 1, url: 'u1', state: 'CLOSED', merged: true, isDraft: false, title: 'A' },
            { number: 2, url: 'u2', state: 'CLOSED', merged: false, isDraft: false },
            { number: 3, url: 'u3', state: 'OPEN', merged: false, isDraft: true },
          ],
        },
      },
      'ia-flow',
    )
    expect(links.pullRequests.map((pr) => pr.state)).toEqual(['merged', 'closed', 'open'])
    expect(links.pullRequests[0].title).toBe('A')
    expect(links.pullRequests[2].isDraft).toBe(true)
  })

  test('drops nodes without number or url instead of emitting a broken link', () => {
    const links = mapDevLinks(
      { closedByPullRequestsReferences: { nodes: [{ number: 1 }, { url: 'u' }] } },
      undefined,
    )
    expect(links.pullRequests).toEqual([])
  })

  test('empty dev links for a null/absent content node', () => {
    expect(mapDevLinks(null, 'ia-flow')).toEqual({ pullRequests: [] })
  })
})

describe('unsupported PR field detection', () => {
  test('recognises a schema error naming the field', () => {
    const err = new Error(
      "GitHub GraphQL errors: Field 'closedByPullRequestsReferences' doesn't exist on type 'Issue'",
    )
    expect(isUnsupportedPullRequestFieldError(err)).toBe(true)
  })

  test('does not swallow unrelated GraphQL failures', () => {
    expect(isUnsupportedPullRequestFieldError(new Error('rate limit exceeded'))).toBe(false)
  })

  test('the selection asks for both halves while the field is supported', () => {
    const sel = issueDevLinksSelection()
    expect(sel).toContain('linkedBranches(first: 5)')
    expect(sel).toContain('closedByPullRequestsReferences')
  })
})
