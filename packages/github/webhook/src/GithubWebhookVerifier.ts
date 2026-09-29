import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Verifica la firma `x-hub-signature-256` que GitHub manda en cada delivery de webhook —
 * HMAC-SHA256 sobre el body CRUDO con el secret configurado del lado de GitHub. Comparación
 * timing-safe: un `===` normal filtra por cuánto tarda en fallar cuánto del prefijo coincide.
 */
export class GithubWebhookVerifier {
  constructor(private readonly secret: string) {}

  /**
   * `payload` tiene que ser el body EXACTO que llegó (string u/o Buffer crudo, nunca
   * `JSON.parse`+re-serializado) — la firma es sobre esos bytes, no sobre una representación
   * "equivalente".
   */
  verify(payload: string | Buffer, signatureHeader: string | undefined | null): boolean {
    if (!signatureHeader) return false
    const expected = `sha256=${createHmac('sha256', this.secret).update(payload).digest('hex')}`
    const expectedBuf = Buffer.from(expected)
    const actualBuf = Buffer.from(signatureHeader)
    if (expectedBuf.length !== actualBuf.length) return false
    return timingSafeEqual(expectedBuf, actualBuf)
  }
}
