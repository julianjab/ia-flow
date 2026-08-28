import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { base64url, createPkcePair, randomState } from './pkce.js'

describe('pkce', () => {
  it('el challenge es el SHA-256 del verifier en base64url', () => {
    const { verifier, challenge, method } = createPkcePair()
    expect(method).toBe('S256')
    expect(challenge).toBe(base64url(createHash('sha256').update(verifier).digest()))
  })

  it('el verifier respeta el charset y el largo mínimo de la RFC 7636', () => {
    const { verifier } = createPkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/)
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier.length).toBeLessThanOrEqual(128)
  })

  it('dos pares no comparten verifier', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier)
  })

  it('base64url no deja padding ni caracteres que rompan una URL', () => {
    const out = base64url(Buffer.from([251, 255, 190, 0]))
    expect(out).not.toContain('=')
    expect(out).not.toContain('+')
    expect(out).not.toContain('/')
  })

  it('el state es determinista respecto de su fuente de azar', () => {
    const fixed = () => Buffer.alloc(16, 7)
    expect(randomState(fixed)).toBe(randomState(fixed))
    expect(randomState()).not.toBe(randomState())
  })
})
