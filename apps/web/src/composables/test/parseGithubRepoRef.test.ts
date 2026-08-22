import { describe, expect, it } from 'vitest'
import {
  formatGithubRepoSlug,
  formatGithubRepoUrl,
  parseGithubOwner,
  parseGithubRepoRef,
} from '../parseGithubRepoRef'

describe('parseGithubRepoRef', () => {
  it.each([
    'https://github.com/julianjab/accountant',
    'http://github.com/julianjab/accountant',
    'https://www.github.com/julianjab/accountant',
    'github.com/julianjab/accountant',
    'https://github.com/julianjab/accountant/',
    'https://github.com/julianjab/accountant/issues',
    'https://github.com/julianjab/accountant.git',
    'julianjab/accountant',
    '  julianjab/accountant  ',
    'https://github.com/julianjab/accountant?tab=readme-ov-file',
    'https://github.com/julianjab/accountant#readme',
    'https://github.com/julianjab/accountant/issues?q=is%3Aopen',
  ])('parses %s', (input) => {
    expect(parseGithubRepoRef(input)).toEqual({ owner: 'julianjab', repo: 'accountant' })
  })

  it.each([
    ['', 'vacío'],
    ['   ', 'sólo espacios'],
    ['julianjab', 'sin repo'],
    ['https://github.com/julianjab', 'URL sin repo'],
    ['https://gitlab.com/acme/api', 'otro host'],
    ['https://bitbucket.org/acme/api', 'otro host'],
  ])('rejects %s (%s)', (input) => {
    expect(parseGithubRepoRef(input)).toBeNull()
  })
})

describe('parseGithubOwner', () => {
  it('reads the owner before the repo is typed', () => {
    expect(parseGithubOwner('julianjab/')).toBe('julianjab')
    expect(parseGithubOwner('https://github.com/julianjab')).toBe('julianjab')
    expect(parseGithubOwner('julianjab/accountant')).toBe('julianjab')
  })

  it('never reads a non-GitHub host as the owner', () => {
    expect(parseGithubOwner('https://gitlab.com/acme')).toBe('')
    expect(parseGithubOwner('')).toBe('')
  })
})

describe('format helpers', () => {
  it('need both halves', () => {
    expect(formatGithubRepoSlug({ owner: 'julianjab', repo: 'accountant' })).toBe(
      'julianjab/accountant',
    )
    expect(formatGithubRepoSlug({ owner: 'julianjab' })).toBe('')
    expect(formatGithubRepoUrl({ owner: 'julianjab', repo: 'accountant' })).toBe(
      'https://github.com/julianjab/accountant',
    )
    expect(formatGithubRepoUrl({ repo: 'accountant' })).toBe('')
  })

  it('round-trips whatever the parser accepted', () => {
    const ref = parseGithubRepoRef('github.com/julianjab/accountant.git')
    expect(parseGithubRepoRef(formatGithubRepoUrl(ref ?? {}))).toEqual(ref)
  })
})
