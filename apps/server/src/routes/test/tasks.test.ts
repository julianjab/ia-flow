import { describe, expect, it } from 'bun:test'
import { buildCreateItemInput, parseGithubUrl } from '../tasks.js'

describe('parseGithubUrl', () => {
  it('parses full https URL', () => {
    expect(parseGithubUrl('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    })
  })

  it('parses URL without protocol', () => {
    expect(parseGithubUrl('github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  it('parses owner/repo shorthand', () => {
    expect(parseGithubUrl('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  it('strips .git suffix', () => {
    expect(parseGithubUrl('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    })
  })

  it('parses git@ SSH form', () => {
    expect(parseGithubUrl('git@github.com:owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
    })
  })

  it('ignores extra path segments', () => {
    expect(parseGithubUrl('https://github.com/owner/repo/tree/main')).toEqual({
      owner: 'owner',
      repo: 'repo',
    })
  })

  it('returns null on garbage input', () => {
    expect(parseGithubUrl('')).toBeNull()
    expect(parseGithubUrl('nope')).toBeNull()
  })
})

describe('buildCreateItemInput', () => {
  it('keeps only title when every optional field is omitted', () => {
    expect(buildCreateItemInput({ title: 'T' })).toEqual({ title: 'T' })
  })

  it('includes description, type, repos, status and draft when present', () => {
    const input = buildCreateItemInput({
      title: 'T',
      description: 'D',
      type: 'technical',
      repos: ['repo-a'],
      status: 'In Progress',
      draft: false,
    })
    expect(input).toEqual({
      title: 'T',
      description: 'D',
      type: 'technical',
      repos: ['repo-a'],
      status: 'In Progress',
      draft: false,
    })
  })

  it('includes draft:true explicitly when passed (does not collapse to omitted)', () => {
    expect(buildCreateItemInput({ title: 'T', draft: true })).toEqual({ title: 'T', draft: true })
  })

  it('omits status/draft/repos independently when only some are set', () => {
    expect(buildCreateItemInput({ title: 'T', status: 'Done' })).toEqual({
      title: 'T',
      status: 'Done',
    })
    expect(buildCreateItemInput({ title: 'T', repos: ['a', 'b'] })).toEqual({
      title: 'T',
      repos: ['a', 'b'],
    })
  })
})
