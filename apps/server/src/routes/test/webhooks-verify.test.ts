import { describe, expect, test } from 'bun:test'
import { createHmac } from 'crypto'
import { githubHint, isIssueEvent, verifyGithubSignature } from '../webhooks.js'

// El handshake y la firma de Slack se testean en `@ia-flow/slack`, junto al
// código que los implementa — acá quedaba sólo el borde de GitHub.

const sign = (body: string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

describe('verifyGithubSignature', () => {
  const body = JSON.stringify({ action: 'edited' })

  test('accepts a correct signature', () => {
    expect(verifyGithubSignature(body, sign(body, 's3cret'), 's3cret')).toBe(true)
  })

  test('rejects a wrong secret, tampered body, or missing header', () => {
    expect(verifyGithubSignature(body, sign(body, 'other'), 's3cret')).toBe(false)
    expect(verifyGithubSignature(`${body} `, sign(body, 's3cret'), 's3cret')).toBe(false)
    expect(verifyGithubSignature(body, undefined, 's3cret')).toBe(false)
  })

  test('rejects a truncated header without throwing', () => {
    expect(() => verifyGithubSignature(body, 'sha256=abc', 's3cret')).not.toThrow()
    expect(verifyGithubSignature(body, 'sha256=abc', 's3cret')).toBe(false)
  })
})

describe('isIssueEvent', () => {
  test('accepts the events that can change an issue', () => {
    for (const event of ['issues', 'issue_comment', 'projects_v2_item', 'projects_v2']) {
      expect(isIssueEvent(event)).toBe(true)
    }
  })

  test('rejects the CI/push events that only cause redundant scans', () => {
    for (const event of [
      'workflow_run',
      'workflow_job',
      'check_run',
      'check_suite',
      'push',
      'create',
      'unknown',
    ]) {
      expect(isIssueEvent(event)).toBe(false)
    }
  })
})

describe('githubHint', () => {
  test('extracts the project node id from projects_v2_item events', () => {
    const hint = githubHint('projects_v2_item', {
      projects_v2_item: { project_node_id: 'PVT_kwDO', content_type: 'Issue' },
    })
    expect(hint).toEqual({ event: 'projects_v2_item', projectNodeId: 'PVT_kwDO' })
  })

  test('extracts the project node id from projects_v2 events', () => {
    expect(githubHint('projects_v2', { projects_v2: { node_id: 'PVT_x' } }).projectNodeId).toBe(
      'PVT_x',
    )
  })

  test('falls back to the repository for issue events', () => {
    expect(githubHint('issues', { repository: { full_name: 'la-haus/api' } })).toEqual({
      event: 'issues',
      repoFullName: 'la-haus/api',
    })
  })

  test('carries no discriminator when the payload has none', () => {
    expect(githubHint('push', {})).toEqual({ event: 'push' })
  })
})
