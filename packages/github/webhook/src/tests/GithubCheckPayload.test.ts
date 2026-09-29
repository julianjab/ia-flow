import { describe, expect, it } from 'vitest'
import { parseGithubCheckPayload } from '../GithubCheckPayload.js'

const repository = { name: 'subscriptions', owner: { login: 'la-haus' } }

describe('parseGithubCheckPayload', () => {
  it('flattens a workflow_run, keeping which event it came from', () => {
    const payload = parseGithubCheckPayload('workflow_run', {
      action: 'completed',
      workflow_run: {
        name: 'CI',
        status: 'completed',
        conclusion: 'failure',
        head_branch: 'ia-flow/7',
        head_sha: 'abc123',
        html_url: 'https://github.com/la-haus/subscriptions/actions/runs/1',
        pull_requests: [{ number: 12 }],
      },
      repository,
    })
    expect(payload).toEqual({
      kind: 'workflow_run',
      owner: 'la-haus',
      repo: 'subscriptions',
      name: 'CI',
      status: 'completed',
      conclusion: 'failure',
      branch: 'ia-flow/7',
      sha: 'abc123',
      url: 'https://github.com/la-haus/subscriptions/actions/runs/1',
      prNumbers: [12],
    })
  })

  it('names a check_suite after its App, and leaves conclusion empty while it runs', () => {
    const payload = parseGithubCheckPayload('check_suite', {
      action: 'requested',
      check_suite: {
        status: 'queued',
        conclusion: null,
        head_branch: 'main',
        head_sha: 'def456',
        url: 'https://api.github.com/repos/la-haus/subscriptions/check-suites/9',
        app: { name: 'GitHub Actions' },
        pull_requests: [],
      },
      repository,
    })
    expect(payload).toMatchObject({
      kind: 'check_suite',
      name: 'GitHub Actions',
      conclusion: '',
      prNumbers: [],
    })
  })
})
