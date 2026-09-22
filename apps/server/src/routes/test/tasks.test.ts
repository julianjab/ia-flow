import { describe, expect, it } from 'bun:test'
import {
  buildCreateItemInput,
  parseGithubUrl,
  parseResolveForEventQuery,
  toResolvedItemPayload,
} from '../tasks.js'

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

describe('parseResolveForEventQuery', () => {
  it('rechaza sin projectId', () => {
    expect(parseResolveForEventQuery({})).toEqual({ error: 'projectId query param is required' })
  })

  it('projectId solo produce un scope vacío', () => {
    expect(parseResolveForEventQuery({ projectId: 'p1' })).toEqual({
      projectId: 'p1',
      scope: {},
    })
  })

  it('parsea issueId, prNumber y repos juntos', () => {
    expect(
      parseResolveForEventQuery({
        projectId: 'p1',
        issueId: 'I_1',
        prNumber: '42',
        repos: 'repo-a, repo-b',
      }),
    ).toEqual({
      projectId: 'p1',
      scope: { issueId: 'I_1', prNumber: 42, repos: ['repo-a', 'repo-b'] },
    })
  })

  it('un prNumber no numérico se descarta en vez de mandar NaN', () => {
    expect(parseResolveForEventQuery({ projectId: 'p1', prNumber: 'nope' })).toEqual({
      projectId: 'p1',
      scope: {},
    })
  })
})

describe('toResolvedItemPayload', () => {
  it('expone el mismo vocabulario que ISSUE_FIELDS, con listas nunca undefined', () => {
    expect(
      toResolvedItemPayload({
        id: 'T1',
        title: 'Arreglar el login',
        description: '',
        status: 'Ready',
        type: 'technical',
        repos: ['core'],
        issueNumber: 7,
        issueUrl: 'https://github.com/x/y/issues/7',
      } as never),
    ).toEqual({
      id: 'T1',
      title: 'Arreglar el login',
      status: 'Ready',
      type: 'technical',
      repos: ['core'],
      labels: [],
      assignees: [],
      issueNumber: 7,
      issueUrl: 'https://github.com/x/y/issues/7',
    })
  })
})
