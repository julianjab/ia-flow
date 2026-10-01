/**
 * `@ia-flow/agent-engine-datasource-sqlite/node`: la base con `node:sqlite` (Node ≥ 22.13). Vive en su
 * propio entry para que el paquete principal cargue en otros runtimes (Bun trae su `bun:sqlite`).
 */
import { DatabaseSync } from 'node:sqlite'
import type { SqliteDatabase } from './SqliteDatabase.js'
import { SqliteExecutionStore } from './SqliteExecutionStore.js'

/** Abre (o crea) la base en `path` — `:memory:` para una en memoria. Con archivo, en modo WAL. */
export function openNodeSqlite(path: string): SqliteDatabase {
  const database = new DatabaseSync(path)
  if (path !== ':memory:') database.exec('PRAGMA journal_mode = WAL')
  return database
}

/**
 * El driver `sqlite` para el `engine.yaml` de `@ia-flow/agent-engine-datasource-yaml`
 * (`createEngineFromYaml(path, { drivers: { sqlite: sqliteStoreDriver } })`). `path` es obligatorio:
 * sin archivo, las pausas no sobreviven a un reinicio y no hace falta SQLite.
 */
export function sqliteStoreDriver(options: {
  path?: string
  maxConcurrent?: number
}): SqliteExecutionStore {
  if (!options.path) {
    throw new Error('executions.path: el driver sqlite necesita el archivo de la base')
  }
  return new SqliteExecutionStore({
    database: openNodeSqlite(options.path),
    ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
  })
}
