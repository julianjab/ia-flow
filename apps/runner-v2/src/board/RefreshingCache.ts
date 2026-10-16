/**
 * Un valor caro de leer —las cards de un board: varias páginas de GraphQL, 5 s— que se sirve
 * viejo mientras se relee en segundo plano (stale-while-revalidate).
 *
 * - `get` con un valor: lo devuelve ya. Si está viejo (`markStale`, o pasó el `ttlMs`), además
 *   arranca UNA relectura en segundo plano; los que pidan mientras tanto siguen con el viejo.
 * - `get` sin valor (el primero, o tras `invalidate`): espera la lectura; los que llegan juntos
 *   comparten la misma.
 * - `markStale` (un webhook): no frena a nadie. Una ráfaga de webhooks durante una relectura deja
 *   pedida UNA más, no una por webhook.
 * - `invalidate` (quien necesita el dato real, ya): el próximo `get` espera una lectura que
 *   arrancó después; una que estaba en vuelo no cuenta (pudo leer antes del cambio).
 * - Cuando una relectura trae algo distinto, `onRefreshed(antes, ahora)`: quien mira se entera sin
 *   preguntar (la bandeja publica el evento `inbox`).
 *
 * Si una relectura en segundo plano falla, queda el valor viejo y se reintenta recién pasado
 * `retryMs` (GitHub caído no se golpea en cada pedido).
 */

export interface RefreshingCacheOptions<T> {
  /** Cuánto vale un valor sin que nadie lo marque viejo. */
  ttlMs: number
  /** Tras una relectura fallida, cuánto esperar antes de la próxima. Default: 5 s. */
  retryMs?: number
  now?: () => number
  onRefreshed?: (previous: T | undefined, next: T) => void
  onError?: (error: unknown) => void
}

export class RefreshingCache<T> {
  private value: { data: T; at: number } | undefined
  private stale = false
  /** Sube con cada `invalidate`: una lectura de una generación anterior no se guarda. */
  private generation = 0
  private inflight: { promise: Promise<T>; generation: number } | undefined
  private failedAt: number | undefined

  constructor(
    private readonly load: () => Promise<T>,
    private readonly options: RefreshingCacheOptions<T>,
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  get(): Promise<T> {
    const current = this.value
    if (!current) return this.refresh()
    const expired = this.now() - current.at > this.options.ttlMs
    const cooling =
      this.failedAt !== undefined && this.now() - this.failedAt < (this.options.retryMs ?? 5_000)
    if ((this.stale || expired) && !cooling) {
      this.refresh().catch(() => {
        // Ya avisado en `refresh`: el que pidió se lleva el valor viejo.
      })
    }
    return Promise.resolve(current.data)
  }

  /** Lo que se sirve está viejo: se relee la próxima vez que alguien pida, sin hacerlo esperar. */
  markStale(): void {
    this.stale = true
    this.failedAt = undefined
  }

  /** El próximo `get` espera un valor leído desde ahora. */
  invalidate(): void {
    this.generation += 1
    this.value = undefined
    this.stale = false
    this.failedAt = undefined
  }

  private refresh(): Promise<T> {
    if (this.inflight && this.inflight.generation === this.generation) return this.inflight.promise
    const generation = this.generation
    // Lo que se marque viejo DURANTE esta lectura vuelve a poner `stale`: pide otra después.
    this.stale = false
    const promise = this.load().then(
      (data) => {
        if (generation !== this.generation) return data
        const previous = this.value?.data
        this.value = { data, at: this.now() }
        this.failedAt = undefined
        try {
          this.options.onRefreshed?.(previous, data)
        } catch {
          // Quien escucha no puede romper la caché.
        }
        return data
      },
      (error: unknown) => {
        if (generation === this.generation) {
          this.failedAt = this.now()
          this.stale = true
        }
        this.options.onError?.(error)
        throw error
      },
    )
    const entry = { promise, generation }
    this.inflight = entry
    const clear = () => {
      if (this.inflight === entry) this.inflight = undefined
    }
    promise.then(clear, clear)
    return promise
  }
}
