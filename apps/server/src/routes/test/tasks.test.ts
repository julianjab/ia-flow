import { describe, expect, it } from 'bun:test'
import { parseGithubUrl } from './tasks.js'

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
