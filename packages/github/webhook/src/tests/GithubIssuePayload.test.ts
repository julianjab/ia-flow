import { describe, expect, it } from 'vitest'
import { parseGithubIssueCommentPayload, parseGithubIssuePayload } from '../GithubIssuePayload.js'

function issuesPayload(overrides: Record<string, unknown> = {}) {
  return {
    issue: {
      title: 'App crashes on login',
      body: 'steps to reproduce...',
      number: 42,
      labels: [{ name: 'bug' }, { name: 'p1' }],
    },
    repository: { name: 'accountant', owner: { login: 'julianjab' } },
    sender: { login: 'someone' },
    ...overrides,
  }
}

describe('parseGithubIssuePayload', () => {
  it('extracts every field, normalizing label objects to plain names', () => {
    const payload = parseGithubIssuePayload(issuesPayload())

    expect(payload).toEqual({
      title: 'App crashes on login',
      body: 'steps to reproduce...',
      number: 42,
      owner: 'julianjab',
      repo: 'accountant',
      labels: ['bug', 'p1'],
      sender: 'someone',
      isPullRequest: false,
    })
  })

  it('defaults to an empty labels array when the issue has none', () => {
    const payload = parseGithubIssuePayload(
      issuesPayload({ issue: { title: 't', body: 'b', number: 1, labels: undefined } }),
    )
    expect(payload.labels).toEqual([])
  })

  it('does not decide any event "type" or filter by action — that is the app\'s job', () => {
    // Ningún argumento de acción/tipo — la función no sabe ni le importa qué action trajo el
    // webhook, sólo extrae lo que hay en el shape de `issues`.
    const payload = parseGithubIssuePayload(issuesPayload())
    expect(payload).not.toHaveProperty('type')
    expect(payload).not.toHaveProperty('action')
  })

  it('flags a PR delivered through the issues API', () => {
    const payload = parseGithubIssuePayload(
      issuesPayload({
        issue: { title: 't', body: 'b', number: 5, labels: [], pull_request: { url: 'x' } },
      }),
    )
    expect(payload.isPullRequest).toBe(true)
  })
})

describe('parseGithubIssueCommentPayload', () => {
  it('extracts the issue fields plus the comment id/body', () => {
    const payload = parseGithubIssueCommentPayload({
      ...issuesPayload({ issue: { title: 't', body: 'b', number: 7, labels: [] } }),
      comment: { id: 999, body: 'looks good' },
    })

    expect(payload).toMatchObject({ number: 7, commentId: 999, commentBody: 'looks good' })
  })
})
