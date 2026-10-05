import type { RunCount, RunCounter } from '@ia-flow/agent-engine'
import { migrate } from './migrations.js'
import type { SqliteDatabase } from './SqliteDatabase.js'

/**
 * El `RunCounter` de `maxRuns` sobre SQLite (tabla `run_counts`): sobrevive a un reinicio, así un
 * loop no recupera su presupuesto entero cada vez que el runner se reinicia.
 */
export class SqliteRunCounter implements RunCounter {
  constructor(private readonly db: SqliteDatabase) {
    migrate(this.db)
  }

  get(key: string, counter: string): RunCount {
    const row = this.db
      .prepare('SELECT count, last_at FROM run_counts WHERE key = ? AND counter = ?')
      .get(key, counter) as { count: number; last_at: number | null } | undefined | null
    if (!row) return { count: 0 }
    return { count: row.count, ...(row.last_at !== null ? { lastAt: row.last_at } : {}) }
  }

  hit(key: string, counter: string, at: number): number {
    this.db
      .prepare(
        `INSERT INTO run_counts (key, counter, count, last_at) VALUES (?, ?, 1, ?)
         ON CONFLICT (key, counter) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
      )
      .run(key, counter, at)
    return this.get(key, counter).count
  }

  reset(key: string, counter?: string): void {
    if (counter !== undefined) {
      this.db.prepare('DELETE FROM run_counts WHERE key = ? AND counter = ?').run(key, counter)
    } else {
      this.db.prepare('DELETE FROM run_counts WHERE key = ?').run(key)
    }
  }
}
