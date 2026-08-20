import { describe, expect, test } from 'bun:test'
import type { IssueItem } from '../../contract.js'
import { matchesProjectFilter, resolveProjectFilter } from '../project-filter.js'

function issueItem(overrides: Partial<IssueItem> = {}): IssueItem {
  return {
    id: 'i1',
    title: 'T',
    description: '',
    type: '',
    repos: [],
    status: 'Todo',
    agentWorking: false,
    labels: [],
    assignees: [],
    fields: {},
    ...overrides,
  }
}

describe('resolveProjectFilter', () => {
  test('returns undefined when settings is absent', () => {
    expect(resolveProjectFilter(undefined)).toBeUndefined()
  })

  test('returns undefined when settings has none of the filter keys', () => {
    expect(resolveProjectFilter({ daemonMode: 'polling' })).toBeUndefined()
  })

  test('reads statusName/repoName/when off settings', () => {
    const filter = resolveProjectFilter({
      statusName: 'Build',
      repoName: 'ia-flow',
      when: [{ field: 'type', op: '=', value: 'functional' }],
    })
    expect(filter).toEqual({
      statusName: 'Build',
      repoName: 'ia-flow',
      when: [{ field: 'type', op: '=', value: 'functional' }],
    })
  })

  test('ignores malformed values instead of throwing', () => {
    const filter = resolveProjectFilter({ statusName: 42, repoName: null, when: 'not-an-array' })
    expect(filter).toEqual({ statusName: undefined, repoName: undefined, when: undefined })
  })
})

describe('matchesProjectFilter', () => {
  test('undefined filter matches everything', () => {
    expect(matchesProjectFilter(issueItem(), undefined)).toBe(true)
  })

  test('statusName gates case-insensitively', () => {
    const filter = { statusName: 'build' }
    expect(matchesProjectFilter(issueItem({ status: 'Build' }), filter)).toBe(true)
    expect(matchesProjectFilter(issueItem({ status: 'Refine' }), filter)).toBe(false)
  })

  test('repoName gates by membership in item.repos', () => {
    const filter = { repoName: 'ia-flow' }
    expect(matchesProjectFilter(issueItem({ repos: ['ia-flow', 'other'] }), filter)).toBe(true)
    expect(matchesProjectFilter(issueItem({ repos: ['other'] }), filter)).toBe(false)
  })

  test('when evaluates the same DSL as agent activation', () => {
    const filter = { when: [{ field: 'type', op: '=', value: 'functional' }] }
    expect(matchesProjectFilter(issueItem({ type: 'functional' }), filter)).toBe(true)
    expect(matchesProjectFilter(issueItem({ type: 'technical' }), filter)).toBe(false)
  })

  test('all set criteria must match (AND)', () => {
    const filter = { statusName: 'build', repoName: 'ia-flow' }
    expect(matchesProjectFilter(issueItem({ status: 'Build', repos: ['ia-flow'] }), filter)).toBe(
      true,
    )
    expect(matchesProjectFilter(issueItem({ status: 'Build', repos: ['other'] }), filter)).toBe(
      false,
    )
  })
})
