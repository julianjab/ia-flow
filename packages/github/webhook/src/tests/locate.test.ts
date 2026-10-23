import { describe, expect, it } from 'vitest'
import { closedIssue, locate, mergedPullRequest } from '../locate.js'

const issuesPayload = (action: string, extra: Record<string, unknown> = {}) => ({
  action,
  issue: { number: 12, title: 'Algo', body: '', labels: [{ name: 'refine' }] },
  repository: { name: 'ia-flow', owner: { login: 'julianjab' } },
  sender: { login: 'julianjab' },
  ...extra,
})

describe('locate — issues', () => {
  it('opened is issue.opened on the issue of the repo', () => {
    expect(locate('issues', issuesPayload('opened'))).toEqual({
      owner: 'julianjab',
      repo: 'ia-flow',
      number: 12,
      emit: 'issue.opened',
      extra: { action: 'opened', sender: 'julianjab' },
    })
  })

  it('labeled carries the label that was added', () => {
    expect(locate('issues', issuesPayload('labeled', { label: { name: 'build' } }))).toMatchObject({
      emit: 'issue.labeled',
      number: 12,
      extra: { action: 'labeled', label: 'build', sender: 'julianjab' },
    })
  })

  it('unlabeled carries the label that was taken off', () => {
    expect(
      locate('issues', issuesPayload('unlabeled', { label: { name: 'blocked' } })),
    ).toMatchObject({ emit: 'issue.unlabeled', extra: { label: 'blocked' } })
  })

  it('skips the actions no pipeline listens to', () => {
    expect(locate('issues', issuesPayload('edited'))).toEqual({ skip: 'issues.edited' })
    expect(locate('issues', issuesPayload('closed'))).toEqual({ skip: 'issues.closed' })
  })

  it('skips an issue that is really a pull request', () => {
    const payload = issuesPayload('labeled', { label: { name: 'build' } })
    ;(payload.issue as Record<string, unknown>).pull_request = { url: 'x' }
    expect(locate('issues', payload)).toEqual({ skip: 'issues.labeled de un PR' })
  })
})

describe('locate — pull_request', () => {
  const prPayload = (action: string, extra: Record<string, unknown> = {}) => ({
    action,
    pull_request: {
      number: 30,
      title: 'Arregla X',
      body: '',
      state: 'open',
      user: { login: 'julianjab' },
      head: { ref: 'fix/x', sha: 'abc' },
      base: { ref: 'main' },
      html_url: 'https://github.com/julianjab/ia-flow/pull/30',
    },
    repository: { name: 'ia-flow', owner: { login: 'julianjab' } },
    sender: { login: 'julianjab' },
    ...extra,
  })

  it('labeled carries the label at the root, as in issues', () => {
    expect(
      locate('pull_request', prPayload('labeled', { label: { name: 'e2e-test' } })),
    ).toMatchObject({
      pr: 30,
      inspect: 30,
      emit: 'pull_request',
      extra: { action: 'labeled', label: 'e2e-test', pr: { head: { ref: 'fix/x' } } },
    })
  })

  it('an action without a label has no label', () => {
    const located = locate('pull_request', prPayload('opened'))
    expect('extra' in located && located.extra).not.toHaveProperty('label')
  })
})

describe('closedIssue', () => {
  it('a closed issue is the issue, with why it was closed', () => {
    const raw = issuesPayload('closed')
    ;(raw.issue as Record<string, unknown>).state_reason = 'not_planned'
    expect(closedIssue(raw)).toEqual({
      owner: 'julianjab',
      repo: 'ia-flow',
      number: 12,
      stateReason: 'not_planned',
    })
  })

  it('without state_reason it was completed, as GitHub assumes', () => {
    expect(closedIssue(issuesPayload('closed'))).toMatchObject({
      number: 12,
      stateReason: 'completed',
    })
  })

  it('any other action is skipped', () => {
    expect(closedIssue(issuesPayload('reopened'))).toEqual({ skip: 'issues.reopened' })
  })

  it('a closed PR is not an issue that finished', () => {
    const raw = issuesPayload('closed')
    ;(raw.issue as Record<string, unknown>).pull_request = { url: 'x' }
    expect(closedIssue(raw)).toEqual({ skip: 'issues.closed de un PR' })
  })
})

describe('mergedPullRequest', () => {
  const closed = (merged: boolean) => ({
    action: 'closed',
    pull_request: {
      number: 10,
      merged,
      head: { ref: 'feat/a', sha: 'abc' },
      base: { ref: 'main' },
    },
    repository: { name: 'api', owner: { login: 'la-haus' } },
  })

  it('a merged PR, with its branch, its tip and the branch it went into', () => {
    expect(mergedPullRequest(closed(true))).toEqual({
      owner: 'la-haus',
      repo: 'api',
      pr: 10,
      head: 'feat/a',
      headSha: 'abc',
      base: 'main',
    })
  })

  it('a PR closed without merging is skipped', () => {
    expect(mergedPullRequest(closed(false))).toEqual({ skip: 'PR #10 cerrado sin mergear' })
  })
})
