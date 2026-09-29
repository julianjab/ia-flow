/** Un tope de cuántos lugares se usan a la vez. */
export class Semaphore {
  private used = 0
  private readonly waiters: Array<() => void> = []

  constructor(private limit: number) {
    if (!(limit >= 1)) throw new Error(`Semaphore: max tiene que ser ≥ 1 (llegó ${limit})`)
  }

  get max(): number {
    return this.limit
  }

  /** Cambia el tope en caliente (una config que se recargó). Subirlo deja pasar a los que
   *  esperaban; bajarlo no corta a nadie: los que ya tienen lugar lo devuelven al terminar. */
  resize(max: number): void {
    if (!(max >= 1)) throw new Error(`Semaphore: max tiene que ser ≥ 1 (llegó ${max})`)
    this.limit = max
    while (this.used < this.limit && this.waiters.length > 0) {
      this.used++
      this.waiters.shift()?.()
    }
  }

  /** Los lugares en uso. */
  get active(): number {
    return this.used
  }

  async acquire(): Promise<void> {
    // El lugar se TRASPASA al que espera sin bajar `used`: si se liberara y el siguiente lo
    // tomara en un microtask, otro podría colarse en el medio y pasar el tope.
    if (this.used >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    } else {
      this.used++
    }
  }

  release(): void {
    // Con el tope bajado en caliente, un lugar que se libera por encima del tope nuevo no se
    // traspasa: se pierde hasta quedar debajo.
    const next = this.used <= this.limit ? this.waiters.shift() : undefined
    if (next) next()
    else this.used--
  }
}
