import type { Database } from 'bun:sqlite'
import type { IProjectSettingsRepository } from '../../domain/ports/IProjectSettingsRepository.js'

export class SqliteProjectSettingsRepository implements IProjectSettingsRepository {
  constructor(private db: Database) {}

  getAll(): Record<string, string> {
    const rows = this.db.query('SELECT key, value FROM project_settings').all() as {
      key: string
      value: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  }

  get(key: string): string | null {
    const row = this.db.query('SELECT value FROM project_settings WHERE key = ?').get(key) as {
      value: string
    } | null
    return row?.value ?? null
  }

  set(key: string, value: string): void {
    this.db.run(
      `INSERT INTO project_settings (key, value) VALUES (?, ?)
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
    this.db.run('DELETE FROM project_settings WHERE key = ?', [key])
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
