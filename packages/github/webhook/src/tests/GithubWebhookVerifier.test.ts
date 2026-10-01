import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { GithubWebhookVerifier } from '../GithubWebhookVerifier.js'

function sign(secret: string, payload: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`
}

describe('GithubWebhookVerifier', () => {
  const secret = 'whsec_test'
  const payload = JSON.stringify({ action: 'opened' })

  it('accepts a correctly signed payload', () => {
    const verifier = new GithubWebhookVerifier(secret)
    expect(verifier.verify(payload, sign(secret, payload))).toBe(true)
  })

  it('rejects a payload that was tampered with after signing', () => {
    const verifier = new GithubWebhookVerifier(secret)
    const signature = sign(secret, payload)
    expect(verifier.verify(`${payload}x`, signature)).toBe(false)
  })

  it('rejects a signature made with the wrong secret', () => {
    const verifier = new GithubWebhookVerifier(secret)
    expect(verifier.verify(payload, sign('otro-secret', payload))).toBe(false)
  })

  it('rejects a missing signature header', () => {
    const verifier = new GithubWebhookVerifier(secret)
    expect(verifier.verify(payload, undefined)).toBe(false)
    expect(verifier.verify(payload, null)).toBe(false)
  })

  it('rejects a malformed signature without throwing (different length than expected)', () => {
    const verifier = new GithubWebhookVerifier(secret)
    expect(verifier.verify(payload, 'sha256=short')).toBe(false)
  })
})
