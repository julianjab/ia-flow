import { KeyedQueue, type Turn } from './KeyedQueue.js'
import { Semaphore } from './Semaphore.js'

/**
 * Cuándo le toca correr a una ejecución: su turno en la task (una task nunca corre dos a la vez) y
 * un lugar bajo el tope global. Coordina el proceso — vive en memoria aunque el estado de las
 * ejecuciones se persista.
 */
export class ExecutionScheduler {
  private readonly queue = new KeyedQueue()
  private readonly slots: Semaphore
  private waitingCount = 0

  constructor(maxConcurrent = Number.POSITIVE_INFINITY) {
    this.slots = new Semaphore(maxConcurrent)
  }

  /** Si la task tiene una ejecución corriendo o esperando turno. */
  busy(key: string): boolean {
    return this.queue.busy(key)
  }

  get running(): number {
    return this.slots.active
  }

  get waiting(): number {
    return this.waitingCount
  }

  /**
   * Pide turno en la task y lugar bajo el tope. Todo lo sincrónico va ANTES del primer await: la
   * task queda ocupada en este mismo tick. `release` devuelve las dos cosas.
   */
  enter(key: string): Turn {
    this.waitingCount++
    const turn = this.queue.enqueue(key)
    const ready = (async () => {
      try {
        await turn.ready
        await this.slots.acquire()
      } finally {
        this.waitingCount--
      }
    })()
    return {
      ready,
      release: () => {
        this.slots.release()
        turn.release()
      },
    }
  }
}
