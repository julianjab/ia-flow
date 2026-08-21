import type { Migration } from './runner.js'

// Cuál provider concreto corre detrás de un apps/ai-provider-gateway
// registrado pasa a ser una decisión interna de esa instancia (ver
// GATEWAY_PROVIDER en apps/ai-provider-gateway/src/providers.ts) — el server
// principal ya no la elige ni la persiste. SQLite no soporta DROP COLUMN en
// las versiones que targeteamos, así que se recrea la tabla (mismo patrón
// que 011-repos-per-project / 036-agents-as-primary-entity / 037-agent-tools-unified).
const migration: Migration = {
  id: '044-provider-registrations-drop-remote-provider-id',
  description: 'Drop provider_registrations.remote_provider_id — the gateway resolves it itself',
  up(db) {
    const cols = db.query('PRAGMA table_info(provider_registrations)').all() as { name: string }[]
    const hasColumn = cols.some((c) => c.name === 'remote_provider_id')
    if (!hasColumn) return

    db.run(`
      CREATE TABLE provider_registrations_new (
        id                   TEXT PRIMARY KEY NOT NULL,
        name                 TEXT NOT NULL,
        base_url             TEXT NOT NULL,
        token                TEXT NOT NULL,
        remote_kind          TEXT NOT NULL,
        remote_name          TEXT NOT NULL,
        remote_description   TEXT NOT NULL,
        created_at           TEXT NOT NULL
      )
    `)
    db.run(`
      INSERT INTO provider_registrations_new (
        id, name, base_url, token, remote_kind, remote_name, remote_description, created_at
      )
      SELECT id, name, base_url, token, remote_kind, remote_name, remote_description, created_at
      FROM provider_registrations
    `)
    db.run('DROP TABLE provider_registrations')
    db.run('ALTER TABLE provider_registrations_new RENAME TO provider_registrations')
  },
}

export default migration
