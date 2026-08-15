import type { Database } from 'bun:sqlite'
import type { IGlobalSettingsRepository } from '../../../domain/ports/IGlobalSettingsRepository.js'

export class SqliteGlobalSettingsRepository implements IGlobalSettingsRepository {
  constructor(private db: Database) {}

  getAll(): Record<string, string> {
    const rows = this.db.query('SELECT key, value FROM global_settings').all() as {
      key: string
      value: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  }

  get(key: string): string | null {
    const row = this.db.query('SELECT value FROM global_settings WHERE key = ?').get(key) as {
      value: string
    } | null
    return row?.value ?? null
  }

  set(key: string, value: string): void {
    this.db.run(
      `INSERT INTO global_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    )
  }

  setMany(settings: Record<string, string>): void {
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(settings)) this.set(key, value)
    })()
  }

  delete(key: string): void {
    this.db.run('DELETE FROM global_settings WHERE key = ?', [key])
  }

  getScanRoots(): string[] {
    const raw = this.get('scan_roots')
    if (!raw) return []
    try {
      return JSON.parse(raw) as string[]
    } catch {
      return []
    }
  }

  setScanRoots(roots: string[]): void {
    this.set('scan_roots', JSON.stringify(roots))
  }
}
