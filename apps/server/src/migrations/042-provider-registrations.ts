import type { Migration } from './runner.js'

// Tabla de providers remotos registrados — cada fila apunta a una instancia
// de apps/agent-host (dominio+puerto+credencial) y a cuál de sus
// providers (`remote_provider_id`, ej. "claude-print") queda disponible para
// los agentes vía RemoteAgentProvider (apps/server/src/adapters/remote-provider).
// `remote_kind`/`remote_name`/`remote_description` se capturan al registrar
// (GET /v1/providers del agent-host) para no depender de que esté vivo en cada
// boot del server principal — solo hace falta que responda en el momento del
// POST /api/provider-registrations.
const migration: Migration = {
  id: '042-provider-registrations',
  description: 'Create provider_registrations table (remote agent-host instances)',
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS provider_registrations (
        id                   TEXT PRIMARY KEY NOT NULL,
        name                 TEXT NOT NULL,
        base_url             TEXT NOT NULL,
        remote_provider_id   TEXT NOT NULL,
        token                TEXT NOT NULL,
        remote_kind          TEXT NOT NULL,
        remote_name          TEXT NOT NULL,
        remote_description   TEXT NOT NULL,
        created_at           TEXT NOT NULL
      )
    `)
  },
}

export default migration
