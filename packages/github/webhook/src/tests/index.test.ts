import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import * as lib from '../index.js'

describe('package entrypoint', () => {
  it('exports the public API', () => {
    expect(lib.GithubWebhookVerifier).toBeDefined()
    expect(lib.createGithubWebhookEvent).toBeTypeOf('function')
    expect(lib.parseGithubIssuePayload).toBeTypeOf('function')
    expect(lib.parseGithubIssueCommentPayload).toBeTypeOf('function')
    expect(lib.parseGithubPullRequestPayload).toBeTypeOf('function')
    expect(lib.parseGithubPullRequestReviewPayload).toBeTypeOf('function')
    expect(lib.parseGithubCheckPayload).toBeTypeOf('function')
    expect(lib.parseGithubProjectItemPayload).toBeTypeOf('function')
  })

  it('wires verify + parse + an app-defined translator through the public API only', () => {
    const secret = 'whsec_test'
    const body = JSON.stringify({
      action: 'opened',
      issue: { title: 't', body: 'b', number: 1, labels: [] },
      repository: { name: 'r', owner: { login: 'o' } },
      sender: { login: 's' },
    })
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

    const verifier = new lib.GithubWebhookVerifier(secret)
    expect(verifier.verify(body, signature)).toBe(true)

    // Este mapping action → type es DECISIÓN DE LA APP — no algo que el paquete imponga.
    function translate(eventType: string, payload: Record<string, unknown>) {
      if (eventType !== 'issues' || payload.action !== 'opened') return undefined
      const issue = lib.parseGithubIssuePayload(payload)
      return lib.createGithubWebhookEvent('github.issue.opened', issue, {
        owner: issue.owner,
        repo: issue.repo,
      })
    }

    const event = translate('issues', JSON.parse(body))
    expect(event?.type).toBe('github.issue.opened')
    expect(event?.scope).toEqual({ owner: 'o', repo: 'r' })
  })
})
