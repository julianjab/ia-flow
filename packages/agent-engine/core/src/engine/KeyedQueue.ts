/** Un turno en la cola de una clave: `ready` resuelve cuando termina el anterior; `release` cede. */
export interface Turn {
  ready: Promise<void>
  release: () => void
}

/** Una cola por clave: quien pide turno en una clave espera a que termine el anterior de ESA clave. */
export class KeyedQueue {
  /** La promesa que el próximo turno de cada clave tiene que esperar. */
  private readonly tails = new Map<string, Promise<void>>()

  /** Si la clave tiene un turno tomado o esperando. */
  busy(key: string): boolean {
    return this.tails.has(key)
  }

  /** Pide turno. Sincrónico: la clave queda ocupada en este mismo tick. */
  enqueue(key: string): Turn {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let free!: () => void
    const mine = new Promise<void>((resolve) => {
      free = resolve
    })
    const tail = previous.then(() => mine)
    this.tails.set(key, tail)
    return {
      ready: previous,
      release: () => {
        free()
        if (this.tails.get(key) === tail) this.tails.delete(key)
      },
    }
  }
}
