import { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { runMigrationsSync } from '../../migrations/runner.js'

const HOME = Bun.env.HOME ?? '/Users/julianbuitrago'
const DEFAULT_CONFIG_DIR = join(HOME, '.config', 'ia-flow')

// Both are configurable via env vars so tests, containers and alt installs
// don't collide with the developer's ~/.config/ia-flow SQLite file.
export const CONFIG_DIR = Bun.env.IA_FLOW_CONFIG_DIR ?? DEFAULT_CONFIG_DIR
const DB_PATH = Bun.env.IA_FLOW_DB_PATH ?? join(CONFIG_DIR, 'ia-flow.sqlite')

let _db: Database | null = null

// Every domain lives in its own repo alongside this file. This module only
// owns the DB handle + schema-migration bootstrap. Never add SQL helpers here.
export function getDb(): Database {
  if (_db) return _db
  mkdirSync(CONFIG_DIR, { recursive: true })
  _db = new Database(DB_PATH)

  // WAL: readers no se bloquean contra el writer, que es la situación normal
  // acá (el daemon escribiendo mientras la API lee). busy_timeout: si aun así
  // hay contención — dos procesos con el mismo archivo abierto, p. ej. un
  // `dev` y un `prod` conviviendo — esperar el lock en vez de tirar
  // SQLITE_BUSY al toque y matar el dispatch con 'database is locked'.
  _db.exec('PRAGMA journal_mode = WAL')
  _db.exec('PRAGMA busy_timeout = 5000')

  // All schema DDL lives in migrations/ — see 000-bootstrap-schema.ts for the
  // baseline tables. `getDb()` intentionally does not run any CREATE/DROP so
  // migrations remain the single source of truth for schema shape.
  runMigrationsSync(_db)

  return _db
}
