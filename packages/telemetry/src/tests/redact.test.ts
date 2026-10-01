import { describe, expect, it } from 'vitest'
import { REDACTED, redactSecrets } from '../redact.js'

describe('redactSecrets', () => {
  it('hides the value of a secret key, whatever it holds', () => {
    const out = redactSecrets({
      headers: { Authorization: 'Bearer abc', 'x-api-key': 'k', 'content-type': 'json' },
      mcp_servers: [{ name: 'github', url: 'https://x', authorization_token: 'tok' }],
      password: { nested: true },
    })

    expect(out).toEqual({
      headers: { Authorization: REDACTED, 'x-api-key': REDACTED, 'content-type': 'json' },
      mcp_servers: [{ name: 'github', url: 'https://x', authorization_token: REDACTED }],
      password: REDACTED,
    })
  })

  it('leaves token counts alone', () => {
    const usage = { max_tokens: 16000, input_tokens: 10, budget_tokens: 4000, tokens: 3 }

    expect(redactSecrets(usage)).toEqual(usage)
  })

  it('hides known token formats inside any text, keeping the prefix', () => {
    const text = [
      'ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAA',
      'GITHUB_TOKEN=ghp_BBBBBBBBBBBBBBBBBBBBBBBB',
      'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y"',
      'slack xoxb-1234567890-abcdef',
    ].join('\n')

    const out = redactSecrets({ content: [{ type: 'text', text }] }).content[0]?.text

    expect(out).toContain(`sk-ant-api03-${REDACTED}`)
    expect(out).toContain(`ghp_${REDACTED}`)
    expect(out).toContain(`Bearer ${REDACTED}`)
    expect(out).toContain(`xoxb-${REDACTED}`)
    expect(out).not.toMatch(/AAAAAAAA|BBBBBBBB|eyJhbGci|abcdef/)
  })

  it('hides the body of a private key', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEsecret\n-----END RSA PRIVATE KEY-----'

    expect(redactSecrets(pem)).toBe(
      `-----BEGIN RSA PRIVATE KEY-----${REDACTED}-----END RSA PRIVATE KEY-----`,
    )
  })

  it('does not touch the original', () => {
    const original = { authorization_token: 'tok' }

    redactSecrets(original)

    expect(original.authorization_token).toBe('tok')
  })

  it('survives a cycle', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a

    expect(redactSecrets(a)).toEqual({ name: 'a', self: '[Circular]' })
  })
})
