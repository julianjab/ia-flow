import { ConcurrencyLimits } from './ConcurrencyLimits.js'
import { KeyedQueue, type Turn } from './KeyedQueue.js'
import { Semaphore } from './Semaphore.js'

/** Grupos de tasks con su propio tope (ej. las de un proyecto): a qué grupo es una task, y
 *  cuántas del grupo corren a la vez. Se consulta en cada `enter`: el tope puede cambiar. */
export interface ExecutionGroups {
  of(key: string): string | undefined
  max(group: string): number | undefined
}

/**
 * Cuándo le toca correr a una ejecución: su turno en la task (una task nunca corre dos a la vez),
 * un lugar bajo el tope de su grupo (si tiene) y uno bajo el tope global — en ese orden. Coordina el proceso — vive en memoria aunque el estado de las
 * ejecuciones se persista.
 */
export class ExecutionScheduler {
  private readonly queue = new KeyedQueue()
  private readonly slots: Semaphore
  private waitingCount = 0
  private readonly groupLimits = new ConcurrencyLimits()

  constructor(
    maxConcurrent = Number.POSITIVE_INFINITY,
    private readonly groups?: ExecutionGroups,
  ) {
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
    let releaseGroup = () => {}
    const ready = (async () => {
      try {
        await turn.ready
        const group = this.groups?.of(key)
        if (group !== undefined) {
          releaseGroup = await this.groupLimits.acquire([
            { key: group, max: this.groups?.max(group) },
          ])
        }
        await this.slots.acquire()
      } finally {
        this.waitingCount--
      }
    })()
    return {
      ready,
      release: () => {
        this.slots.release()
        releaseGroup()
        turn.release()
      },
    }
  }
}
