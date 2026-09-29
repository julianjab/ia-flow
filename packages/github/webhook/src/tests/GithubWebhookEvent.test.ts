import { describe, expect, it } from 'vitest'
import { createGithubWebhookEvent } from '../GithubWebhookEvent.js'

describe('createGithubWebhookEvent', () => {
  it('fills in occurredAt and depth around the type/payload/scope the app decided', () => {
    const event = createGithubWebhookEvent(
      'github.issue.opened',
      { title: 't' },
      { owner: 'o', repo: 'r' },
    )

    expect(event.type).toBe('github.issue.opened')
    expect(event.payload).toEqual({ title: 't' })
    expect(event.scope).toEqual({ owner: 'o', repo: 'r' })
    expect(event.depth).toBe(0)
    expect(typeof event.occurredAt).toBe('string')
    expect(new Date(event.occurredAt).toString()).not.toBe('Invalid Date')
  })

  it('scope is optional — omitting it leaves it undefined, not a default {}', () => {
    const event = createGithubWebhookEvent('x', {})
    expect(event.scope).toBeUndefined()
  })
})
