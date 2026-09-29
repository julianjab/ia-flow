import { createHash, randomBytes } from 'node:crypto'

/**
 * PKCE (RFC 7636). El `code_verifier` es el secreto que nunca sale de este
 * proceso; el `code_challenge` es su SHA-256 y es lo único que viaja por el
 * navegador. Es lo que hace seguro un cliente público: quien intercepte el
 * `code` del redirect no lo puede canjear sin el verifier.
 *
 * Módulo puro a propósito — sin fetch, sin fs, sin reloj. Es la pieza que un
 * test puede verificar contra el vector de la RFC sin levantar nada.
 */

export interface PkcePair {
  verifier: string
  challenge: string
  /** Figma sólo publica S256 en `code_challenge_methods_supported`. `plain`
   *  no se implementa: sería un downgrade silencioso del único mecanismo que
   *  protege el code. */
  method: 'S256'
}

export type RandomBytes = (size: number) => Buffer

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 32 bytes → 43 chars en base64url, el mínimo que la RFC pide (43–128). */
export function createPkcePair(random: RandomBytes = randomBytes): PkcePair {
  const verifier = base64url(random(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}

/** Anti-CSRF del redirect. Se compara en el callback: un `state` que no es el
 *  que mandamos significa que ese redirect no lo originamos nosotros. */
export function randomState(random: RandomBytes = randomBytes): string {
  return base64url(random(16))
}
