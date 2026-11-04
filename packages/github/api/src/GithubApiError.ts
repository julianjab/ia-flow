/**
 * Un request a GitHub que no salió. `transient` dice si es de infraestructura —un límite de tasa,
 * un 5xx, la red— y no del pedido en sí: reintentarlo más tarde puede andar, así que quien lo
 * corre (el engine) no lo trata como un fallo de la task. Es un flag y no una clase para que el
 * engine lo reconozca sin depender de este paquete.
 */
export class GithubApiError extends Error {
  readonly transient: boolean
  /** El status HTTP, si GitHub llegó a responder. */
  readonly status?: number
  /** Cuánto pidió GitHub esperar antes de volver a intentar, si lo dijo. */
  readonly retryAfterMs?: number

  constructor(
    message: string,
    opts: { transient: boolean; status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'GithubApiError'
    this.transient = opts.transient
    if (opts.status !== undefined) this.status = opts.status
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs
  }
}
