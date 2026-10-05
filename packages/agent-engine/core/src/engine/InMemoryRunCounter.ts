import type { RunCount, RunCounter } from './RunCounter.js'

/** Un `RunCounter` en memoria: alcanza para un proceso; se pierde al reiniciar. */
export class InMemoryRunCounter implements RunCounter {
  private readonly counts = new Map<string, RunCount>()

  get(key: string, counter: string): RunCount {
    return this.counts.get(entryKey(key, counter)) ?? { count: 0 }
  }

  hit(key: string, counter: string, at: number): number {
    const count = this.get(key, counter).count + 1
    this.counts.set(entryKey(key, counter), { count, lastAt: at })
    return count
  }

  reset(key: string, counter?: string): void {
    if (counter !== undefined) {
      this.counts.delete(entryKey(key, counter))
      return
    }
    const prefix = `${key}\u0000`
    for (const entry of [...this.counts.keys()]) {
      if (entry.startsWith(prefix)) this.counts.delete(entry)
    }
  }
}

function entryKey(key: string, counter: string): string {
  return `${key}\u0000${counter}`
}
