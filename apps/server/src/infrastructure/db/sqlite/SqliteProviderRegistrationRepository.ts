import type { Database } from 'bun:sqlite'
import type {
  IProviderRegistrationRepository,
  ProviderRegistration,
} from '../../../domain/ports/IProviderRegistrationRepository.js'

function rowToRegistration(r: Record<string, unknown>): ProviderRegistration {
  return {
    id: r.id as string,
    name: r.name as string,
    baseUrl: r.base_url as string,
    remoteProviderId: r.remote_provider_id as string,
    token: r.token as string,
    remoteKind: r.remote_kind as 'sync' | 'async',
    remoteName: r.remote_name as string,
    remoteDescription: r.remote_description as string,
    createdAt: r.created_at as string,
  }
}

export class SqliteProviderRegistrationRepository implements IProviderRegistrationRepository {
  constructor(private db: Database) {}

  list(): ProviderRegistration[] {
    const rows = this.db
      .query('SELECT * FROM provider_registrations ORDER BY created_at')
      .all() as Record<string, unknown>[]
    return rows.map(rowToRegistration)
  }

  get(id: string): ProviderRegistration | null {
    const row = this.db
      .query('SELECT * FROM provider_registrations WHERE id = ? LIMIT 1')
      .get(id) as Record<string, unknown> | null
    return row ? rowToRegistration(row) : null
  }

  insert(registration: ProviderRegistration): void {
    this.db.run(
      `INSERT INTO provider_registrations (
         id, name, base_url, remote_provider_id, token,
         remote_kind, remote_name, remote_description, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        registration.id,
        registration.name,
        registration.baseUrl,
        registration.remoteProviderId,
        registration.token,
        registration.remoteKind,
        registration.remoteName,
        registration.remoteDescription,
        registration.createdAt,
      ],
    )
  }

  deleteById(id: string): void {
    this.db.run('DELETE FROM provider_registrations WHERE id = ?', [id])
  }
}
