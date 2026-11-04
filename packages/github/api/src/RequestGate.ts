/**
 * La compuerta de los requests de UNA identidad de GitHub: lo que GitHub pide para no caer en el
 * límite secundario — poca concurrencia, las escrituras de a una y a un ritmo sostenido (un balde:
 * una ráfaga corta sale sin esperar, después una por `writeGapMs`), y, si igual salta, que TODOS
 * esperen (no sólo el request que lo recibió).
 *
 * El reloj y la espera entran por `clock` (un puerto): los tests no duermen de verdad.
 */

export interface GateClock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const realClock: GateClock = {
  now: () => Date.now(),
  sleep: (ms) => (ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))),
}

export interface RequestGateOptions {
  /** Requests en vuelo a la vez. */
  maxConcurrent: number
  /** Las escrituras que salen seguidas sin esperar (el balde lleno). */
  writeBurst: number
  /** Cada cuánto se recupera una escritura del balde: el ritmo sostenido (1 s = 60/min). */
  writeGapMs: number
  clock: GateClock
}

/** Un semáforo FIFO de `permits` lugares. */
class Slots {
  private free: number
  private readonly waiting: Array<() => void> = []

  constructor(permits: number) {
    this.free = Math.max(1, permits)
  }

  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiting.shift()
      if (next) next()
      else this.free++
    }
  }
}

export class RequestGate {
  private readonly slots: Slots
  private readonly writes = new Slots(1)
  /** El balde de escrituras: cuántas quedan y desde cuándo se recarga. */
  private tokens: number
  private refilledAt: number
  private pausedUntil = 0

  constructor(private readonly options: RequestGateOptions) {
    this.slots = new Slots(options.maxConcurrent)
    this.tokens = Math.max(1, options.writeBurst)
    this.refilledAt = options.clock.now()
  }

  /** Corre `send` con un lugar tomado; una escritura además va en serie con las demás. Antes de
   *  salir espera lo que quede de una pausa por límite de tasa. */
  async run<T>(write: boolean, send: () => Promise<T>): Promise<T> {
    const releaseWrite = write ? await this.writes.acquire() : undefined
    try {
      if (write) await this.takeWriteToken()
      await this.waitFor(() => this.pausedUntil)
      const release = await this.slots.acquire()
      try {
        // Pudo saltar un límite mientras esperaba el lugar.
        await this.waitFor(() => this.pausedUntil)
        return await send()
      } finally {
        release()
      }
    } finally {
      releaseWrite?.()
    }
  }

  /** GitHub dijo "pará": nadie de esta identidad sale hasta dentro de `ms`. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.options.clock.now() + ms)
  }

  /** Toma una escritura del balde; vacío, espera a que se recargue una. */
  private async takeWriteToken(): Promise<void> {
    const { writeGapMs, writeBurst, clock } = this.options
    for (;;) {
      const now = clock.now()
      const gained = writeGapMs > 0 ? Math.floor((now - this.refilledAt) / writeGapMs) : writeBurst
      if (gained > 0) {
        this.tokens = Math.min(Math.max(1, writeBurst), this.tokens + gained)
        this.refilledAt = writeGapMs > 0 ? this.refilledAt + gained * writeGapMs : now
      }
      if (this.tokens >= 1) {
        // Lleno, el reloj de recarga arranca recién al gastar la primera.
        if (this.tokens === Math.max(1, writeBurst)) this.refilledAt = now
        this.tokens--
        return
      }
      await clock.sleep(this.refilledAt + writeGapMs - now)
    }
  }

  /** Duerme hasta `until()`, que se relee al despertar: una pausa nueva pudo correr el plazo. */
  private async waitFor(until: () => number): Promise<void> {
    for (;;) {
      const left = until() - this.options.clock.now()
      if (left <= 0) return
      await this.options.clock.sleep(left)
    }
  }
}
