import type { SourceRef } from '@ia-flow/shared'
import { describe, expect, it } from 'vitest'
import { projectSourceUrl, sourceKindLabel } from '../meta'

describe('projectSourceUrl', () => {
  it('uses the board URL a github (Projects v2) source stores', () => {
    expect(
      projectSourceUrl({
        kind: 'github',
        config: { url: 'https://github.com/users/julianjab/projects/2' },
      } as SourceRef),
    ).toBe('https://github.com/users/julianjab/projects/2')
  })

  it('builds the issues URL a github-issues source never stores', () => {
    expect(
      projectSourceUrl({
        kind: 'github-issues',
        config: { owner: 'julianjab', repo: 'accountant' },
      } as SourceRef),
    ).toBe('https://github.com/julianjab/accountant/issues')
  })

  it('github-hybrid linkea al repo/issues, no al board — el set lo define el repo', () => {
    expect(
      projectSourceUrl({
        kind: 'github-hybrid',
        config: {
          owner: 'julianjab',
          repo: 'accountant',
          url: 'https://github.com/users/julianjab/projects/2',
        },
      } as SourceRef),
    ).toBe('https://github.com/julianjab/accountant/issues')
  })

  it.each([
    ['sin fuente', null],
    ['local', { kind: 'local', config: {} }],
    ['github sin url', { kind: 'github', config: {} }],
    ['github-issues sin repo', { kind: 'github-issues', config: { owner: 'julianjab' } }],
    ['kind desconocido', { kind: 'linear', config: { url: 'https://linear.app/x' } }],
  ])('has no URL for %s', (_label, source) => {
    expect(projectSourceUrl(source as SourceRef | null)).toBeNull()
  })
})

describe('sourceKindLabel', () => {
  it('names the shipped kinds', () => {
    expect(sourceKindLabel('github')).toBe('GitHub Projects')
    expect(sourceKindLabel('github-issues')).toBe('GitHub Repo')
    expect(sourceKindLabel('github-hybrid')).toBe('GitHub Repo + Project')
    expect(sourceKindLabel('local')).toBe('Local')
  })

  it('falls back to the raw kind for one it does not know', () => {
    expect(sourceKindLabel('linear')).toBe('linear')
  })
})
