import { Semaphore } from './Semaphore.js'

/** Un lugar con nombre y su tope. Sin `max` (o no finito), no limita. */
export interface Slot {
  key: string
  max?: number
}

/**
 * Topes con nombre, además del global: por agente (`agent:<id>`), por provider
 * (`provider:<id>`), por grupo de tasks (un proyecto). Cada nombre es un `Semaphore` que se crea
 * al primer pedido y toma el tope nuevo si la config cambió. Se piden de a varios y en orden de
 * nombre — dos pedidos que comparten lugares nunca se esperan en cruz.
 */
export class ConcurrencyLimits {
  private readonly semaphores = new Map<string, Semaphore>()
  /** Los que esperan a que se libere cualquier lugar (`released`). */
  private waiting: Array<() => void> = []

  /** Espera lugar en todos los `slots` que limitan; devuelve con qué soltarlos. */
  async acquire(slots: Slot[]): Promise<() => void> {
    const held: Semaphore[] = []
    for (const { key, max } of limited(slots)) {
      const semaphore = this.semaphore(key, max)
      await semaphore.acquire()
      held.push(semaphore)
    }
    return this.releaser(held)
  }

  /** Lugar en todos los `slots` ya mismo, o `undefined` sin tomar ninguno: todo o nada, sin
   *  esperar — para probar el siguiente candidato en vez de hacer cola en éste. */
  tryAcquire(slots: Slot[]): (() => void) | undefined {
    const held: Semaphore[] = []
    for (const { key, max } of limited(slots)) {
      const semaphore = this.semaphore(key, max)
      if (!semaphore.tryAcquire()) {
        for (const taken of held.reverse()) taken.release()
        return undefined
      }
      held.push(semaphore)
    }
    return this.releaser(held)
  }

  /** Resuelve la próxima vez que se libere un lugar, de cualquier nombre. */
  released(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  private releaser(held: Semaphore[]): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      for (const semaphore of held.reverse()) semaphore.release()
      const waiting = this.waiting
      this.waiting = []
      for (const wake of waiting) wake()
    }
  }

  /** Cuántos lugares de `key` están en uso. */
  active(key: string): number {
    return this.semaphores.get(key)?.active ?? 0
  }

  private semaphore(key: string, max: number): Semaphore {
    const existing = this.semaphores.get(key)
    if (!existing) {
      const created = new Semaphore(max)
      this.semaphores.set(key, created)
      return created
    }
    if (existing.max !== max) existing.resize(max)
    return existing
  }
}

/** Los que limitan, en orden de nombre: dos pedidos que comparten lugares no se esperan en cruz. */
function limited(slots: Slot[]): Array<Required<Slot>> {
  return slots
    .filter((slot): slot is Required<Slot> => slot.max !== undefined && Number.isFinite(slot.max))
    .sort((a, b) => a.key.localeCompare(b.key))
}
