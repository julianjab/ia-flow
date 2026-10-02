import { describe, expect, it } from 'vitest'
import { locate } from '../locate.js'

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
