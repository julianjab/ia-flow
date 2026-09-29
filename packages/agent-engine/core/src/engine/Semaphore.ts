/** Un tope de cuántos lugares se usan a la vez. */
export class Semaphore {
  private used = 0
  private readonly waiters: Array<() => void> = []

  constructor(readonly max: number) {
    if (!(max >= 1)) throw new Error(`Semaphore: max tiene que ser ≥ 1 (llegó ${max})`)
  }

  /** Los lugares en uso. */
  get active(): number {
    return this.used
  }

  async acquire(): Promise<void> {
    // El lugar se TRASPASA al que espera sin bajar `used`: si se liberara y el siguiente lo
    // tomara en un microtask, otro podría colarse en el medio y pasar el tope.
    if (this.used >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    } else {
      this.used++
    }
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.used--
  }
}
