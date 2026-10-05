/** Cuántas corridas contadas lleva un contador de una task, y cuándo fue la última. */
export interface RunCount {
  count: number
  /** `Date.now()` de la última corrida contada. */
  lastAt?: number
}

/**
 * Dónde se cuentan las corridas de `maxRuns`, por task (`key`, la clave de su ejecución) y
 * contador. Puerto SÍNCRONO, como `ExecutionRepository`: el coordinador decide y cuenta en el
 * mismo tick en que la corrida toma su turno, sin ceder.
 */
export interface RunCounter {
  get(key: string, counter: string): RunCount
  /** Suma una corrida y devuelve la cuenta nueva. */
  hit(key: string, counter: string, at: number): number
  /** Pone en cero ese contador de la task; sin `counter`, todos los de la task. */
  reset(key: string, counter?: string): void
}
