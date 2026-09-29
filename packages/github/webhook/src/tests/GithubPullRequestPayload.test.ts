import { describe, expect, it } from 'vitest'
import {
  parseGithubPullRequestPayload,
  parseGithubPullRequestReviewPayload,
} from '../GithubPullRequestPayload.js'

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'closed',
    pull_request: {
      number: 12,
      title: 'feat: paginate leads',
      body: 'Closes #7',
      state: 'closed',
      draft: false,
      merged: true,
      html_url: 'https://github.com/la-haus/subscriptions/pull/12',
      user: { login: 'ai-lh-developer[bot]' },
      head: { ref: 'ia-flow/7', sha: 'abc123' },
      base: { ref: 'main' },
      ...overrides,
    },
    repository: { name: 'subscriptions', owner: { login: 'la-haus' } },
    sender: { login: 'julian' },
  }
}

describe('parseGithubPullRequestPayload', () => {
  it('flattens the PR fields a rule or translator needs', () => {
    expect(parseGithubPullRequestPayload(prPayload())).toEqual({
      number: 12,
      title: 'feat: paginate leads',
      body: 'Closes #7',
      owner: 'la-haus',
      repo: 'subscriptions',
      state: 'closed',
      isDraft: false,
      merged: true,
      author: 'ai-lh-developer[bot]',
      headRef: 'ia-flow/7',
      headSha: 'abc123',
      baseRef: 'main',
      url: 'https://github.com/la-haus/subscriptions/pull/12',
      sender: 'julian',
    })
  })

  it('treats a missing body and a missing merged flag as empty/false, not undefined', () => {
    const payload = parseGithubPullRequestPayload(prPayload({ body: null, merged: undefined }))
    expect(payload.body).toBe('')
    expect(payload.merged).toBe(false)
  })

  it("does not carry the action — distinguishing opened/closed is the app's job", () => {
    expect(parseGithubPullRequestPayload(prPayload())).not.toHaveProperty('action')
  })
})

describe('parseGithubPullRequestReviewPayload', () => {
  it('adds the review, with the state lower-cased', () => {
    const payload = parseGithubPullRequestReviewPayload({
      ...prPayload(),
      review: { state: 'CHANGES_REQUESTED', user: { login: 'reviewer' }, body: 'fix the test' },
    })
    expect(payload).toMatchObject({
      number: 12,
      reviewState: 'changes_requested',
      reviewer: 'reviewer',
      reviewBody: 'fix the test',
    })
  })
})
