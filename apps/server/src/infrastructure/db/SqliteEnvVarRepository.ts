import type { Database } from 'bun:sqlite'
import type { IEnvVarRepository } from '../../domain/ports/IEnvVarRepository.js'

export class SqliteEnvVarRepository implements IEnvVarRepository {
  constructor(private db: Database) {}

  get(key: string): string | null {
    const row = this.db
      .query('SELECT value FROM project_settings WHERE key = ?')
      .get(`env.${key}`) as { value: string } | null
    return row?.value ?? null
  }

  set(key: string, value: string): void {
    this.db.run(
      `INSERT INTO project_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [`env.${key}`, value],
    )
  }

  delete(key: string): void {
    this.db.run('DELETE FROM project_settings WHERE key = ?', [`env.${key}`])
  }

  loadIntoProcess(): void {
    const rows = this.db
      .query("SELECT key, value FROM project_settings WHERE key LIKE 'env.%'")
      .all() as { key: string; value: string }[]
    for (const { key, value } of rows) {
      const envKey = key.slice(4) // strip "env." prefix
      ;(Bun.env as Record<string, string>)[envKey] = value
    }
  }
}
