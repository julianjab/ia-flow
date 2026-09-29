import { describe, expect, it } from 'vitest'
import { issuePath, summarizeIssue } from '../shared.js'

describe('issuePath', () => {
  it('builds /repos/{owner}/{repo}/issues/{number} with an optional suffix', () => {
    expect(issuePath('o', 'r', 1)).toBe('/repos/o/r/issues/1')
    expect(issuePath('o', 'r', 1, '/comments')).toBe('/repos/o/r/issues/1/comments')
  })

  it('accepts owner/repo names with dots, dashes and underscores', () => {
    expect(issuePath('my-org_2', 'repo.name', 1)).toBe('/repos/my-org_2/repo.name/issues/1')
  })

  it('rejects a path traversal segment in owner or repo', () => {
    expect(() => issuePath('o', '../../orgs/other-org/repos', 1)).toThrow('repo')
    expect(() => issuePath('../x', 'r', 1)).toThrow('owner')
  })

  it('rejects an owner/repo containing a slash', () => {
    expect(() => issuePath('o/extra', 'r', 1)).toThrow('owner')
  })

  it('rejects a non-integer or non-positive issue number', () => {
    expect(() => issuePath('o', 'r', 1.5)).toThrow('number')
    expect(() => issuePath('o', 'r', -1)).toThrow('number')
    expect(() => issuePath('o', 'r', 0)).toThrow('number')
  })
})

describe('summarizeIssue', () => {
  it('normalizes label objects to plain names and defaults a null body to an empty string', () => {
    const result = summarizeIssue({
      number: 1,
      title: 't',
      body: null,
      state: 'open',
      html_url: 'u',
      labels: [{ name: 'bug' }, 'p1'],
    })

    expect(JSON.parse(result)).toEqual({
      number: 1,
      title: 't',
      body: '',
      state: 'open',
      labels: ['bug', 'p1'],
      url: 'u',
    })
  })
})
