import type { Database } from 'bun:sqlite'
import type { StepType } from '@ia-flow/shared'
import type { IPromptRepository } from '../../domain/ports/IPromptRepository.js'

export class SqlitePromptRepository implements IPromptRepository {
  constructor(private db: Database) {}

  getPhasePrompt(step: StepType): string | null {
    const row = this.db
      .query('SELECT value FROM project_settings WHERE key = ?')
      .get(`prompt.${step}`) as { value: string } | null
    return row?.value ?? null
  }

  setPhasePrompt(step: StepType, text: string): void {
    this.db.run(
      `INSERT INTO project_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [`prompt.${step}`, text],
    )
  }

  getUtilityPrompt(key: string): string | null {
    const row = this.db
      .query('SELECT value FROM project_settings WHERE key = ?')
      .get(`util.${key}`) as { value: string } | null
    return row?.value ?? null
  }

  setUtilityPrompt(key: string, text: string): void {
    this.db.run(
      `INSERT INTO project_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [`util.${key}`, text],
    )
  }

  getProviderConfigBlob(): Record<string, unknown> | null {
    const row = this.db
      .query('SELECT value FROM project_settings WHERE key = ?')
      .get('provider_config') as { value: string } | null
    if (!row) return null
    try {
      return JSON.parse(row.value) as Record<string, unknown>
    } catch {
      return null
    }
  }

  setProviderConfigBlob(config: Record<string, unknown>): void {
    this.db.run(
      `INSERT INTO project_settings (key, value) VALUES ('provider_config', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify(config)],
    )
  }

  deleteProviderConfigBlob(): void {
    this.db.run("DELETE FROM project_settings WHERE key = 'provider_config'")
  }
}
